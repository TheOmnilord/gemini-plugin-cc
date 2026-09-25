#!/usr/bin/env node
// Claude Code companion for the Gemini CLI: code reviews, second opinions and
// delegated tasks, with job tracking so background runs can be followed up.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalizeArgv, parseArgs } from "./lib/args.mjs";
import {
  classifyFailure,
  geminiHomeDir,
  GeminiUnavailableError,
  getAuthStatus,
  getGeminiVersion,
  INSTALL_COMMAND,
  isRunSuccessful,
  isSupportedGeminiVersion,
  MIN_GEMINI_VERSION,
  modelsUsed,
  resolveGeminiLaunch,
  runGemini,
  touchedFiles,
  usageSummary
} from "./lib/gemini.mjs";
import { collectReviewContext, DEFAULT_MAX_INLINE_BYTES, getRepoRoot, requireRepoRoot, resolveReviewTarget } from "./lib/git.mjs";
import {
  ACTIVE_STATUSES,
  appendLog,
  createJob,
  dataRoot,
  findJob,
  jobFiles,
  listJobs,
  loadJob,
  nowIso,
  pruneJobs,
  readLogTail,
  saveJob
} from "./lib/jobs.mjs";
import { killProcessTree, runShellLine } from "./lib/proc.mjs";
import {
  ASK_FINAL_INSTRUCTION,
  buildFollowUpPrompt,
  buildReviewPrompt,
  buildTaskPrompt,
  FOLLOW_UP_FINAL_INSTRUCTION,
  REVIEW_FINAL_INSTRUCTION,
  TASK_FINAL_INSTRUCTION
} from "./lib/prompts.mjs";
import * as render from "./lib/render.mjs";
import { parseReview } from "./lib/review.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const POLICIES_DIR = path.join(PLUGIN_ROOT, "policies");
const DEFAULT_TIMEOUT_MINUTES = { review: 20, "adversarial-review": 20, ask: 15, task: 30 };
const activeChildren = new Set();

function usage() {
  return [
    "Usage: node gemini-companion.mjs <command> [options]",
    "",
    "  setup [--check] [--model <m>] [--json]",
    "  review [--base <ref>] [--scope auto|working-tree|branch] [--model <m>] [--max-diff-kb <n>] [--timeout-min <n>] [focus]",
    "  adversarial-review [same options as review] [focus]",
    "  ask [--resume-last|--fresh] [--model <m>] [--prompt-file <f>] [--timeout-min <n>] [question | stdin]",
    "  task [--write] [--background] [--resume-last|--fresh] [--model <m>] [--prompt-file <f>] [--timeout-min <n>] [request | stdin]",
    "  status [job-id] [--all] [--json]",
    "  result [job-id] [--json]",
    "  cancel [job-id] [--json]",
    "  resume-candidate [--json]",
    "",
    "Common: --cwd <dir> (-C). Models: pro, flash, flash-lite, auto or a full Gemini model id."
  ].join("\n");
}

function write(text) {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function shorten(text, limit) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function firstLine(text) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^[#>*\s-]+/, "").trim())
      .find(Boolean) ?? ""
  );
}

function resolveCwd(options) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function workspaceRootFor(cwd) {
  return getRepoRoot(cwd) ?? path.resolve(cwd);
}

function resolveModel(options) {
  const model = String(options.model ?? process.env.GEMINI_COMPANION_MODEL ?? "").trim();
  return model || null;
}

function resolveTimeoutMs(options, kind) {
  const raw = options["timeout-min"];
  const minutes = raw === undefined ? DEFAULT_TIMEOUT_MINUTES[kind] : Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`Invalid --timeout-min value "${raw}".`);
  }
  return Math.round(minutes * 60_000);
}

function resolveDiffBudget(options) {
  const raw = options["max-diff-kb"] ?? process.env.GEMINI_COMPANION_MAX_DIFF_KB;
  if (raw === undefined || raw === "") {
    return DEFAULT_MAX_INLINE_BYTES;
  }
  const kilobytes = Number(raw);
  if (!Number.isFinite(kilobytes) || kilobytes < 16) {
    throw new Error(`Invalid --max-diff-kb value "${raw}" (minimum 16).`);
  }
  return Math.round(kilobytes * 1024);
}

// Every run blocks shell commands, read-only runs also block edits, and reviews
// block web access. Passing --policy makes the Gemini CLI skip the user's own
// policy folder, so that folder is passed along too.
function policyFiles({ write = false, review = false } = {}) {
  const files = [path.join(POLICIES_DIR, "no-shell.toml")];
  if (!write) {
    files.push(path.join(POLICIES_DIR, "no-edits.toml"));
  }
  if (review) {
    files.push(path.join(POLICIES_DIR, "review.toml"));
  }
  const userPolicies = path.join(geminiHomeDir(), "policies");
  if (fs.existsSync(userPolicies)) {
    files.push(userPolicies);
  }
  return files;
}

function requireLaunch() {
  const launch = resolveGeminiLaunch();
  if (!launch) {
    throw new GeminiUnavailableError();
  }
  return launch;
}

// Reads piped stdin (for heredoc prompts) without hanging when nothing is piped.
function readStdin({ idleMs = 1500 } = {}) {
  if (process.stdin.isTTY) {
    return Promise.resolve("");
  }
  return new Promise((resolve) => {
    let data = "";
    let received = false;
    const finish = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.destroy();
      resolve(data);
    };
    const timer = setTimeout(() => {
      if (!received) {
        finish();
      }
    }, idleMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      received = true;
      data += chunk;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

async function readRequest(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8").trim();
  }
  const piped = (await readStdin()).trim();
  return [positionals.join(" ").trim(), piped].filter(Boolean).join("\n\n");
}

async function executeJob(job, request) {
  job.status = "running";
  job.pid = process.pid;
  job.startedAt = nowIso();
  job.model = request.model ?? null;
  saveJob(job);
  appendLog(
    job.logFile,
    `${job.title} started (pid ${process.pid}, approval ${request.approvalMode}${request.model ? `, model ${request.model}` : ""}${
      request.resumeSessionId ? `, resuming ${request.resumeSessionId}` : ""
    })`
  );

  let run;
  try {
    run = await runGemini({
      ...request,
      onLog: (line) => appendLog(job.logFile, line),
      onSpawn: (child) => {
        activeChildren.add(child);
        job.geminiPid = child.pid;
        saveJob(job);
      },
      onExit: (child) => activeChildren.delete(child)
    });
  } catch (error) {
    finishJob(job, "failed", `${error.message}\n`, error.message);
    throw error;
  }

  job.geminiSessionId = run.sessionId ?? request.resumeSessionId ?? request.sessionId ?? null;
  job.model = run.model ?? job.model;
  job.modelsUsed = modelsUsed(run);
  job.exitCode = run.exitCode;
  job.durationMs = run.durationMs;
  job.usage = usageSummary(run);
  if (run.transcript) {
    appendLog(job.logFile, `answer:\n${run.transcript}`);
  }
  if (run.stderr) {
    appendLog(job.logFile, `stderr:\n${run.stderr.split(/\r?\n/).slice(-40).join("\n")}`);
  }
  return run;
}

function finishJob(job, status, output, summary) {
  const files = jobFiles(job.workspaceRoot, job.id);
  fs.mkdirSync(path.dirname(files.result), { recursive: true });
  fs.writeFileSync(files.result, output, "utf8");
  // A cancel issued while Gemini was running wins over the late result.
  const onDisk = loadJob(job.workspaceRoot, job.id);
  job.status = onDisk?.status === "cancelled" ? "cancelled" : status;
  job.completedAt = nowIso();
  job.resultFile = files.result;
  job.resultSummary = summary;
  if (status === "failed" && !job.errorMessage) {
    job.errorMessage = summary;
  }
  saveJob(job);
  pruneJobs(job.workspaceRoot);
}

function findResumeCandidate(workspaceRoot) {
  const jobs = listJobs(workspaceRoot);
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null;
  const resumable = jobs.filter((job) => job.geminiSessionId && job.status === "completed");
  const mine = sessionId ? resumable.filter((job) => job.claudeSessionId === sessionId) : [];
  const job = (mine.length ? mine : resumable)[0] ?? null;
  if (!job) {
    return null;
  }
  const busy = jobs.find((other) => ACTIVE_STATUSES.has(other.status) && other.geminiSessionId === job.geminiSessionId) ?? null;
  return { job, busy };
}

function resolveResumeSession(workspaceRoot, options) {
  if (options["resume-session"]) {
    return options["resume-session"];
  }
  if (options.fresh || !(options["resume-last"] || options.resume)) {
    return null;
  }
  const candidate = findResumeCandidate(workspaceRoot);
  if (!candidate) {
    throw new Error("There is no earlier Gemini conversation in this repository to continue. Drop --resume to start a new one.");
  }
  if (candidate.busy) {
    throw new Error(`Gemini job ${candidate.busy.id} is still running in that conversation. Wait for it (/gemini:status) before continuing.`);
  }
  return candidate.job.geminiSessionId;
}

async function handleSetup(argv) {
  const { options } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd", "model"],
    booleanOptions: ["json", "check"],
    aliasMap: { C: "cwd", m: "model" }
  });

  const launch = resolveGeminiLaunch();
  const npmProbe = runShellLine("npm --version");
  const geminiVersion = launch ? getGeminiVersion(launch) : null;
  const report = {
    ready: false,
    node: { version: process.version, supported: Number(process.versions.node.split(".")[0]) >= 20 },
    npm: { available: npmProbe.status === 0, version: npmProbe.status === 0 ? npmProbe.stdout.trim() : null },
    gemini: launch
      ? { installed: true, version: geminiVersion, supported: isSupportedGeminiVersion(geminiVersion), source: launch.source }
      : { installed: false },
    auth: getAuthStatus(),
    live: null,
    defaultModel: process.env.GEMINI_COMPANION_MODEL?.trim() || null,
    dataDir: dataRoot(),
    nextSteps: []
  };

  if (options.check && launch) {
    report.live = await runLiveCheck(launch, resolveModel(options));
  }

  if (!report.gemini.installed) {
    report.nextSteps.push(
      report.npm.available ? `Install the Gemini CLI: \`${INSTALL_COMMAND}\`` : `Install Node.js 20+ (includes npm), then run \`${INSTALL_COMMAND}\`.`
    );
  } else if (report.gemini.supported === false) {
    report.nextSteps.push(`Update the Gemini CLI to ${MIN_GEMINI_VERSION} or newer: \`${INSTALL_COMMAND}\``);
  } else if (!report.auth.configured) {
    report.nextSteps.push(
      "Sign in once: open a terminal, run `gemini`, choose **Sign in with Google**, finish in the browser, then type `/quit`. " +
        "Alternatively put `GEMINI_API_KEY=<key>` (from https://aistudio.google.com/app/apikey) in `~/.gemini/.env`."
    );
  }
  if (report.live && !report.live.ok) {
    report.nextSteps.push(report.live.hint);
  }
  if (report.gemini.installed && report.auth.configured && !report.live) {
    report.nextSteps.push("Run `/gemini:setup --check` to confirm with a live request.");
  }
  report.ready =
    report.gemini.installed && report.gemini.supported !== false && report.auth.configured && (report.live ? report.live.ok : true);

  write(options.json ? JSON.stringify(report, null, 2) : render.renderSetup(report));
}

async function runLiveCheck(launch, model) {
  // An empty scratch folder keeps Gemini from scanning a real project. It is
  // never trusted interactively, so it is trusted for this run only.
  const cwd = path.join(dataRoot(), "live-check");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const run = await runGemini({
      launch,
      cwd,
      env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
      prompt: "Connectivity check from the Claude Code gemini plugin.",
      finalInstruction: "Reply with exactly the single word READY.",
      approvalMode: "default",
      policyFiles: policyFiles({ review: true }),
      model,
      sessionId: randomUUID(),
      timeoutMs: 120_000
    });
    if (isRunSuccessful(run)) {
      return { ok: true, durationMs: run.durationMs, models: modelsUsed(run) };
    }
    const failure = classifyFailure(run);
    const excerpt = [run.stderr, ...run.errors].filter(Boolean).join("\n").trim().split(/\r?\n/).slice(-12).join("\n");
    return { ok: false, kind: failure.kind, message: failure.message, hint: failure.hint, excerpt };
  } catch (error) {
    return { ok: false, kind: "error", message: error.message, hint: "Run `gemini` in a terminal to see what it reports." };
  }
}

async function handleReview(argv, kind) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["base", "scope", "model", "cwd", "max-diff-kb", "timeout-min"],
    booleanOptions: ["json", "wait", "background"],
    aliasMap: { C: "cwd", m: "model" }
  });

  const repoRoot = requireRepoRoot(resolveCwd(options));
  const target = resolveReviewTarget(repoRoot, { base: options.base, scope: options.scope });
  const context = collectReviewContext(repoRoot, target, { maxInlineBytes: resolveDiffBudget(options) });
  const label = kind === "adversarial-review" ? "Adversarial Review" : "Review";
  if (context.empty) {
    write(render.renderNothingToReview(label, context));
    return;
  }

  const launch = requireLaunch();
  const focus = positionals.join(" ").trim();
  const job = createJob({
    kind,
    title: `Gemini ${label}`,
    summary: `${label} of ${target.label}${focus ? ` (focus: ${shorten(focus, 60)})` : ""}`,
    workspaceRoot: repoRoot,
    targetLabel: target.label
  });

  const run = await executeJob(job, {
    launch,
    cwd: repoRoot,
    prompt: buildReviewPrompt(kind, context, focus),
    finalInstruction: REVIEW_FINAL_INSTRUCTION,
    approvalMode: "default",
    policyFiles: policyFiles({ review: true }),
    model: resolveModel(options),
    sessionId: randomUUID(),
    timeoutMs: resolveTimeoutMs(options, kind)
  });

  let output;
  let review = null;
  if (isRunSuccessful(run)) {
    review = parseReview(run.text);
    output = render.renderReview({ label, context, focus, review, answer: run.text, job });
    finishJob(job, "completed", output, review ? `${review.verdict}: ${shorten(review.summary, 90)}` : shorten(firstLine(run.text), 90));
  } else {
    const failure = classifyFailure(run);
    output = render.renderFailure({ title: `Gemini ${label}`, failure, run, job });
    finishJob(job, "failed", output, failure.message);
    process.exitCode = 1;
  }
  write(options.json ? JSON.stringify({ job, review, answer: run.text }, null, 2) : output);
}

async function handleConsult(argv, kind) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["model", "cwd", "prompt-file", "timeout-min", "resume-session"],
    booleanOptions: ["json", "write", "read-only", "resume-last", "resume", "fresh", "background", "wait"],
    aliasMap: { C: "cwd", m: "model" }
  });
  if (options.fresh && (options["resume-last"] || options.resume)) {
    throw new Error("Choose either --resume or --fresh, not both.");
  }

  const cwd = resolveCwd(options);
  const workspaceRoot = workspaceRootFor(cwd);
  const writeMode = kind === "task" && Boolean(options.write) && !options["read-only"];
  const request = await readRequest(cwd, options, positionals);
  const resumeSessionId = resolveResumeSession(workspaceRoot, options);
  if (!request && !resumeSessionId) {
    throw new Error("Nothing to send to Gemini: give the request as text, with --prompt-file, or on stdin.");
  }
  const launch = requireLaunch();

  const runRequest = {
    cwd: workspaceRoot,
    prompt: resumeSessionId
      ? buildFollowUpPrompt(request || "Continue where you left off.")
      : buildTaskPrompt({ request, write: writeMode, kind, workspaceRoot }),
    finalInstruction: resumeSessionId ? FOLLOW_UP_FINAL_INSTRUCTION : kind === "ask" ? ASK_FINAL_INSTRUCTION : TASK_FINAL_INSTRUCTION,
    approvalMode: writeMode ? "auto_edit" : "default",
    policyFiles: policyFiles({ write: writeMode }),
    model: resolveModel(options),
    resumeSessionId,
    sessionId: resumeSessionId ? null : randomUUID(),
    timeoutMs: resolveTimeoutMs(options, kind)
  };
  const jobFields = {
    kind,
    title: kind === "ask" ? "Gemini Ask" : writeMode ? "Gemini Task (write)" : "Gemini Task",
    summary: shorten(request || "(continue)", 90),
    workspaceRoot,
    write: writeMode,
    resumedFrom: resumeSessionId
  };

  if (options.background) {
    const job = createJob({ ...jobFields, request: runRequest });
    const worker = spawn(process.execPath, [SCRIPT_PATH, "run-job", "--job-id", job.id, "--cwd", workspaceRoot], {
      cwd: workspaceRoot,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    worker.unref();
    // The worker records its own pid once it starts; only fill it in if it has not.
    const queued = loadJob(workspaceRoot, job.id);
    if (queued?.status === "queued" && !queued.pid) {
      queued.pid = worker.pid;
      saveJob(queued);
    }
    write(options.json ? JSON.stringify({ jobId: job.id, status: "queued" }, null, 2) : render.renderQueued(job));
    return;
  }

  const job = createJob(jobFields);
  const run = await executeJob(job, { launch, ...runRequest });
  const output = finalizeConsult(job, run);
  write(options.json ? JSON.stringify({ job, answer: run.text }, null, 2) : output);
}

function finalizeConsult(job, run) {
  if (isRunSuccessful(run)) {
    const output = render.renderConsult({ job, answer: run.text, editedFiles: job.write ? touchedFiles(run, job.workspaceRoot) : [] });
    finishJob(job, "completed", output, shorten(firstLine(run.text), 90));
    return output;
  }
  const failure = classifyFailure(run);
  const output = render.renderFailure({ title: job.title, failure, run, job });
  finishJob(job, "failed", output, failure.message);
  process.exitCode = 1;
  return output;
}

async function handleRunJob(argv) {
  const { options } = parseArgs(argv, { valueOptions: ["job-id", "cwd"] });
  const workspaceRoot = workspaceRootFor(resolveCwd(options));
  const job = loadJob(workspaceRoot, options["job-id"]);
  if (!job?.request || job.status !== "queued") {
    return;
  }
  const launch = resolveGeminiLaunch();
  if (!launch) {
    const error = new GeminiUnavailableError();
    finishJob(job, "failed", `${error.message}\n`, error.message);
    return;
  }
  const run = await executeJob(job, { launch, ...job.request });
  finalizeConsult(job, run);
}

function sessionScopedJobs(workspaceRoot, all) {
  const jobs = listJobs(workspaceRoot);
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (all || !sessionId) {
    return { jobs, hiddenCount: 0, scoped: false };
  }
  const visible = jobs.filter((job) => job.claudeSessionId === sessionId || ACTIVE_STATUSES.has(job.status));
  return { jobs: visible, hiddenCount: jobs.length - visible.length, scoped: true };
}

function handleStatus(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"],
    aliasMap: { C: "cwd" }
  });
  const workspaceRoot = workspaceRootFor(resolveCwd(options));
  const reference = positionals[0];
  if (reference) {
    const job = findJob(workspaceRoot, reference);
    if (!job) {
      throw new Error(`No Gemini job matches "${reference}" in this repository.`);
    }
    write(options.json ? JSON.stringify(job, null, 2) : render.renderJobDetail(job, readLogTail(job.logFile, 12)));
    return;
  }
  const { jobs, hiddenCount, scoped } = sessionScopedJobs(workspaceRoot, options.all);
  write(options.json ? JSON.stringify(jobs, null, 2) : render.renderStatus(jobs, { scoped, hiddenCount }));
}

function handleResult(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
    aliasMap: { C: "cwd" }
  });
  const workspaceRoot = workspaceRootFor(resolveCwd(options));
  const reference = positionals[0];
  const job = reference
    ? findJob(workspaceRoot, reference)
    : sessionScopedJobs(workspaceRoot, false).jobs.find((candidate) => !ACTIVE_STATUSES.has(candidate.status)) ??
      findJob(workspaceRoot, null, (candidate) => !ACTIVE_STATUSES.has(candidate.status));
  if (!job) {
    write(reference ? `No Gemini job matches "${reference}" in this repository.` : "No finished Gemini jobs in this repository yet.");
    return;
  }
  if (ACTIVE_STATUSES.has(job.status)) {
    write(`Gemini job \`${job.id}\` is still ${job.status}. Check \`/gemini:status ${job.id}\` for progress.`);
    return;
  }
  let output = "";
  try {
    output = fs.readFileSync(job.resultFile ?? jobFiles(workspaceRoot, job.id).result, "utf8");
  } catch {
    output = `Gemini job \`${job.id}\` ended as ${job.status}${job.errorMessage ? `: ${job.errorMessage}` : "."}\n`;
  }
  write(options.json ? JSON.stringify({ job, output }, null, 2) : output);
}

function handleCancel(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
    aliasMap: { C: "cwd" }
  });
  const workspaceRoot = workspaceRootFor(resolveCwd(options));
  const reference = positionals[0];
  const job = reference
    ? findJob(workspaceRoot, reference)
    : sessionScopedJobs(workspaceRoot, false).jobs.find((candidate) => ACTIVE_STATUSES.has(candidate.status));
  if (!job) {
    write(reference ? `No Gemini job matches "${reference}" in this repository.` : "No running Gemini job to cancel.");
    return;
  }
  if (!ACTIVE_STATUSES.has(job.status)) {
    write(`Gemini job \`${job.id}\` already finished (${job.status}).`);
    return;
  }

  job.status = "cancelled";
  job.completedAt = nowIso();
  job.errorMessage = "Cancelled by user.";
  job.resultSummary = "Cancelled by user.";
  saveJob(job);
  if (job.geminiPid) {
    killProcessTree(job.geminiPid);
  }
  if (job.pid && job.pid !== process.pid) {
    killProcessTree(job.pid);
  }
  appendLog(job.logFile, "Cancelled by user.");
  write(options.json ? JSON.stringify({ jobId: job.id, status: job.status }, null, 2) : render.renderCancel(job));
}

function handleResumeCandidate(argv) {
  const { options } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
    aliasMap: { C: "cwd" }
  });
  const candidate = findResumeCandidate(workspaceRootFor(resolveCwd(options)));
  const payload = {
    available: Boolean(candidate && !candidate.busy),
    busyJob: candidate?.busy?.id ?? null,
    candidate: candidate
      ? {
          id: candidate.job.id,
          kind: candidate.job.kind,
          summary: candidate.job.resultSummary ?? candidate.job.summary,
          completedAt: candidate.job.completedAt ?? null,
          sameClaudeSession: candidate.job.claudeSessionId === (process.env.CLAUDE_CODE_SESSION_ID ?? null)
        }
      : null
  };
  if (options.json) {
    write(JSON.stringify(payload, null, 2));
    return;
  }
  write(
    payload.candidate
      ? `Resumable Gemini conversation: ${payload.candidate.id} (${payload.candidate.kind}): ${payload.candidate.summary}${payload.busyJob ? ` [busy: ${payload.busyJob}]` : ""}`
      : "No resumable Gemini conversation in this repository."
  );
}

const HANDLERS = {
  setup: handleSetup,
  review: (argv) => handleReview(argv, "review"),
  "adversarial-review": (argv) => handleReview(argv, "adversarial-review"),
  ask: (argv) => handleConsult(argv, "ask"),
  task: (argv) => handleConsult(argv, "task"),
  "run-job": handleRunJob,
  status: handleStatus,
  result: handleResult,
  cancel: handleCancel,
  "resume-candidate": handleResumeCandidate
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of activeChildren) {
      killProcessTree(child.pid);
    }
    process.exit(130);
  });
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || ["help", "--help", "-h"].includes(subcommand)) {
    write(usage());
    return;
  }
  const handler = HANDLERS[subcommand];
  if (!handler) {
    throw new Error(`Unknown command "${subcommand}".\n\n${usage()}`);
  }
  await handler(argv);
}

main().catch((error) => {
  if (error instanceof GeminiUnavailableError) {
    write(error.message);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
