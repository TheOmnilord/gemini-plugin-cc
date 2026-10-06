#!/usr/bin/env node
// Claude Code companion for Google Gemini: code reviews, second opinions and
// delegated tasks, with job tracking so background runs can be followed up.
// Gemini is reached through the Antigravity CLI by default, or through the
// Gemini CLI when GEMINI_COMPANION_BACKEND=gemini-cli (see lib/backends.mjs).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  AGY_INSTALL_COMMAND,
  AGY_INSTALL_SHELL_COMMAND,
  AGY_SIGN_IN_STEP,
  agyProfileDir,
  getAgyVersion,
  listAgyModels,
  resolveAgyLaunch,
  resolveAgyModel
} from "./lib/agy.mjs";
import { normalizeArgv, parseArgs } from "./lib/args.mjs";
import { getBackend } from "./lib/backends.mjs";
import {
  GeminiUnavailableError,
  getAuthStatus,
  getGeminiVersion,
  INSTALL_COMMAND,
  isSupportedGeminiVersion,
  MIN_GEMINI_VERSION,
  resolveGeminiLaunch
} from "./lib/gemini.mjs";
import { collectReviewContext, DEFAULT_MAX_INLINE_BYTES, getRepoRoot, requireRepoRoot, resolveReviewTarget } from "./lib/git.mjs";
import {
  ACTIVE_STATUSES,
  appendLog,
  cancelJob,
  cancelRequested,
  completeJob,
  createJob,
  dataRoot,
  findJob,
  jobFiles,
  listJobs,
  loadJob,
  pruneJobs,
  readLogTail,
  recordBackendPid,
  startJob
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
import { fetchPages, normalizeUrls } from "./lib/reference.mjs";
import { parseReview, refusedTools, stoppedAfterRefusal } from "./lib/review.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_TIMEOUT_MINUTES = { review: 20, "adversarial-review": 20, ask: 15, task: 30 };
const activeChildren = new Set();

function usage() {
  return [
    "Usage: node gemini-companion.mjs <command> [options]",
    "",
    "  setup [--check] [--model <m>] [--json]",
    "  review [--base <ref>] [--scope auto|working-tree|branch] [--model <m>] [--max-diff-kb <n>] [--timeout-min <n>] [--context-url <url>]... [--allow-url <url>]... [focus]",
    "  adversarial-review [same options as review] [focus]",
    "  ask [--resume-last|--fresh] [--model <m>] [--prompt-file <f>] [--timeout-min <n>] [--allow-url <url>]... [question | stdin]",
    "  task [--write] [--background] [--resume-last|--fresh] [--model <m>] [--prompt-file <f>] [--timeout-min <n>] [--allow-url <url>]... [request | stdin]",
    "  status [job-id] [--all] [--json]",
    "  result [job-id] [--json]",
    "  cancel [job-id] [--json]",
    "  resume-candidate [--json]",
    "",
    "Common: --cwd <dir> (-C). Models: pro, flash, flash-lite, auto or a full model id (/gemini:setup lists them).",
    "Backend: Antigravity CLI (agy) by default; GEMINI_COMPANION_BACKEND=gemini-cli selects the Gemini CLI."
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

// Only agy's guard can hold Gemini to exact addresses; the Gemini CLI's
// web_fetch takes free text that may name any address.
function resolveAllowUrls(options, backend) {
  const urls = normalizeUrls(options["allow-url"], "--allow-url");
  if (urls.length && backend.name !== "agy") {
    throw new Error("--allow-url needs the Antigravity CLI backend: the Gemini CLI cannot limit Gemini to exact addresses. Use --context-url for reviews instead.");
  }
  return urls;
}

function requireLaunch(backend) {
  const launch = backend.resolveLaunch();
  if (!launch) {
    throw backend.unavailableError();
  }
  return launch;
}

// Job records written before backends existed came from the Gemini CLI.
function jobBackend(job) {
  return job.backend ?? "gemini-cli";
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

// Returns null when the job was cancelled (before Gemini started, or while it
// was starting and had to be stopped here), or when another process already
// started it. A cancel during the run usually stops this process instead.
// request.prepare, when given, runs once the job has started and returns
// request fields that take time to gather, so a failure there is recorded on
// the job like any other.
async function executeJob(job, backend, request) {
  if (!startJob(job, { model: request.model ?? null })) {
    appendLog(job.logFile, "Not started: the job was cancelled, or another process started it.");
    return null;
  }
  const stopIfCancelled = () => {
    if (!cancelRequested(job.workspaceRoot, job.id)) {
      return false;
    }
    appendLog(job.logFile, "Cancelled by user.");
    completeJob(job, "cancelled", { errorMessage: "Cancelled by user.", resultSummary: "Cancelled by user." });
    return true;
  };
  appendLog(
    job.logFile,
    `${job.title} started (pid ${process.pid}, ${backend.label}, ${request.write ? "write" : "read-only"}${request.model ? `, model ${request.model}` : ""}${
      request.resumeSessionId ? `, resuming ${request.resumeSessionId}` : ""
    })`
  );

  let run;
  try {
    const prepared = request.prepare ? await request.prepare() : {};
    if (stopIfCancelled()) {
      return null;
    }
    run = await backend.run({
      ...request,
      ...prepared,
      onLog: (line) => appendLog(job.logFile, line),
      onSpawn: (child) => {
        activeChildren.add(child);
        // A cancel that landed while Gemini was starting could not stop it yet.
        if (!recordBackendPid(job, child.pid)) {
          killProcessTree(child.pid);
        }
      },
      onExit: (child) => activeChildren.delete(child)
    });
  } catch (error) {
    if (stopIfCancelled()) {
      return null;
    }
    finishJob(job, "failed", `${error.message}\n`, error.message);
    throw error;
  }
  // Stopped by a cancel rather than failed: not reported as a failure.
  if (stopIfCancelled()) {
    return null;
  }

  job.geminiSessionId = run.sessionId ?? request.resumeSessionId ?? null;
  job.model = run.model ?? job.model;
  job.modelsUsed = backend.modelsUsed(run);
  job.exitCode = run.exitCode;
  job.durationMs = run.durationMs;
  job.usage = backend.usageSummary(run);
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
  completeJob(job, status, {
    resultFile: files.result,
    resultSummary: summary,
    ...(status === "failed" && !job.errorMessage ? { errorMessage: summary } : {})
  });
  pruneJobs(job.workspaceRoot);
}

// Conversations live with the backend that started them, so only those can be continued.
function findResumeCandidate(workspaceRoot, backend) {
  const jobs = listJobs(workspaceRoot).filter((job) => jobBackend(job) === backend.name);
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null;
  const resumable = jobs.filter((job) => job.geminiSessionId && job.status === "completed");
  const mine = sessionId ? resumable.filter((job) => job.claudeSessionId === sessionId) : [];
  const job = (mine.length ? mine : resumable)[0] ?? null;
  if (!job) {
    return null;
  }
  // A run that continues the conversation names it in resumedFrom; its
  // geminiSessionId is only recorded once the run is over.
  const busy =
    jobs.find((other) => ACTIVE_STATUSES.has(other.status) && [other.geminiSessionId, other.resumedFrom].includes(job.geminiSessionId)) ?? null;
  return { job, busy };
}

function resolveResumeSession(workspaceRoot, options, backend) {
  if (options["resume-session"]) {
    return options["resume-session"];
  }
  if (options.fresh || !(options["resume-last"] || options.resume)) {
    return null;
  }
  const candidate = findResumeCandidate(workspaceRoot, backend);
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
  const backend = getBackend();
  const report = backend.name === "agy" ? await agySetupReport(backend, options) : await geminiCliSetupReport(backend, options);
  write(options.json ? JSON.stringify(report, null, 2) : render.renderSetup(report));
}

function nodeReport() {
  return { version: process.version, supported: Number(process.versions.node.split(".")[0]) >= 20 };
}

async function agySetupReport(backend, options) {
  const launch = resolveAgyLaunch();
  const requestedModel = resolveModel(options);
  const report = {
    backend: backend.name,
    ready: false,
    node: nodeReport(),
    agy: launch ? { installed: true, version: getAgyVersion(launch), source: launch.source } : { installed: false },
    signIn: null,
    models: [],
    model: { requested: requestedModel, resolved: resolveAgyModel(requestedModel), available: null },
    profile: agyProfileDir(),
    install: { command: AGY_INSTALL_COMMAND, shellCommand: AGY_INSTALL_SHELL_COMMAND },
    live: null,
    dataDir: dataRoot(),
    nextSteps: []
  };

  if (launch) {
    const listing = listAgyModels(launch);
    report.signIn = { signedIn: listing.signedIn, message: listing.ok ? null : listing.message };
    if (listing.ok) {
      report.models = listing.models.map((entry) => entry.slug);
      report.model.available = report.models.includes(report.model.resolved);
    }
  }
  if (options.check && launch && report.signIn?.signedIn) {
    report.live = await runLiveCheck(backend, launch, requestedModel);
  }

  if (!report.agy.installed) {
    report.nextSteps.push(`Install the Antigravity CLI: \`${AGY_INSTALL_COMMAND}\``);
  } else if (report.signIn?.signedIn === false) {
    report.nextSteps.push(AGY_SIGN_IN_STEP);
    if (process.platform !== "win32") {
      report.nextSteps.push(
        `If you already signed in and this still says signed out, your keyring does not reach the plugin's own agy profile: sign in there once with \`HOME="${report.profile}" agy\`.`
      );
    }
  } else if (report.signIn && !report.signIn.signedIn) {
    report.nextSteps.push(`\`agy models\` failed (${report.signIn.message}). Run \`agy\` in a terminal to see what it reports.`);
  }
  if (report.model.available === false) {
    report.nextSteps.push(
      `This account does not offer \`${report.model.resolved}\`. Pick a model from the list above and pass \`--model <model>\`, or set GEMINI_COMPANION_MODEL.`
    );
  }
  if (report.live && !report.live.ok) {
    report.nextSteps.push(report.live.hint);
  }
  if (report.signIn?.signedIn && report.model.available !== false && !report.live) {
    report.nextSteps.push("Run `/gemini:setup --check` to confirm with a live request.");
  }
  report.ready = report.agy.installed && report.signIn?.signedIn === true && report.model.available !== false && (report.live ? report.live.ok : true);
  return report;
}

async function geminiCliSetupReport(backend, options) {
  const launch = resolveGeminiLaunch();
  const npmProbe = runShellLine("npm --version");
  const geminiVersion = launch ? getGeminiVersion(launch) : null;
  const report = {
    backend: backend.name,
    ready: false,
    node: nodeReport(),
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
    report.live = await runLiveCheck(backend, launch, resolveModel(options));
  }

  if (!report.gemini.installed) {
    report.nextSteps.push(
      report.npm.available ? `Install the Gemini CLI: \`${INSTALL_COMMAND}\`` : `Install Node.js 20+ (includes npm), then run \`${INSTALL_COMMAND}\`.`
    );
  } else if (report.gemini.supported === false) {
    report.nextSteps.push(`Update the Gemini CLI to ${MIN_GEMINI_VERSION} or newer: \`${INSTALL_COMMAND}\``);
  } else if (!report.auth.configured) {
    report.nextSteps.push(
      "Set up a sign-in the Gemini CLI still accepts: `GEMINI_API_KEY=<key>` in `~/.gemini/.env`, Vertex AI, or a Gemini Code Assist Standard or Enterprise account (run `gemini` in a terminal to choose). " +
        "For a personal Google account, use the default Antigravity CLI backend instead."
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
  return report;
}

async function runLiveCheck(backend, launch, model) {
  // An empty scratch folder keeps Gemini from scanning a real project. The
  // Gemini CLI never trusts it interactively, so it is trusted for this run only.
  const cwd = path.join(dataRoot(), "live-check");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const run = await backend.run({
      launch,
      cwd,
      env: backend.name === "gemini-cli" ? { GEMINI_CLI_TRUST_WORKSPACE: "true" } : {},
      prompt: "Connectivity check from the Claude Code gemini plugin.",
      finalInstruction: "Reply with exactly the single word READY.",
      write: false,
      web: false,
      structured: false,
      model,
      timeoutMs: 120_000
    });
    if (backend.isRunSuccessful(run)) {
      return { ok: true, durationMs: run.durationMs, models: backend.modelsUsed(run) };
    }
    const failure = backend.classifyFailure(run);
    const excerpt = [run.stderr, ...run.errors].filter(Boolean).join("\n").trim().split(/\r?\n/).slice(-12).join("\n");
    return { ok: false, kind: failure.kind, message: failure.message, hint: failure.hint, excerpt };
  } catch (error) {
    const command = backend.name === "agy" ? "agy" : "gemini";
    return { ok: false, kind: "error", message: error.message, hint: `Run \`${command}\` in a terminal to see what it reports.` };
  }
}

async function handleReview(argv, kind) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["base", "scope", "model", "cwd", "max-diff-kb", "timeout-min"],
    listOptions: ["context-url", "allow-url"],
    booleanOptions: ["json", "wait", "background"],
    aliasMap: { C: "cwd", m: "model" }
  });

  const backend = getBackend();
  const contextUrls = normalizeUrls(options["context-url"], "--context-url");
  const allowUrls = resolveAllowUrls(options, backend);
  const repoRoot = requireRepoRoot(resolveCwd(options));
  const target = resolveReviewTarget(repoRoot, { base: options.base, scope: options.scope });
  const context = collectReviewContext(repoRoot, target, { maxInlineBytes: resolveDiffBudget(options) });
  const label = kind === "adversarial-review" ? "Adversarial Review" : "Review";
  if (context.empty) {
    write(render.renderNothingToReview(label, context));
    return;
  }

  const launch = requireLaunch(backend);
  const focus = positionals.join(" ").trim();
  const job = createJob({
    kind,
    title: `Gemini ${label}`,
    summary: `${label} of ${target.label}${focus ? ` (focus: ${shorten(focus, 60)})` : ""}`,
    workspaceRoot: repoRoot,
    targetLabel: target.label,
    backend: backend.name,
    contextUrls,
    allowUrls
  });

  // Reviews stay grounded in the repository: no edits, no web. Every page is
  // fetched before Gemini starts, so one that cannot be read fails the job
  // instead of leaving the review silently without that page.
  let pages = [];
  const run = await executeJob(job, backend, {
    launch,
    cwd: repoRoot,
    prepare: async () => {
      pages = await fetchPages(contextUrls);
      return { prompt: buildReviewPrompt(kind, context, focus, backend.prompt, { pages, allowUrls }) };
    },
    finalInstruction: REVIEW_FINAL_INSTRUCTION,
    write: false,
    web: false,
    allowUrls,
    structured: true,
    model: resolveModel(options),
    timeoutMs: resolveTimeoutMs(options, kind)
  });
  if (!run) {
    write(`Gemini job \`${job.id}\` was cancelled.\n`);
    return;
  }

  let output;
  let review = null;
  const refused = refusedTools(run);
  let possiblyIncomplete = false;
  if (backend.isRunSuccessful(run)) {
    review = parseReview(run.text, run.structured);
    possiblyIncomplete = Boolean(review && review.findings.length === 0 && stoppedAfterRefusal(run, repoRoot));
    output = render.renderReview({ label, context, focus, review, answer: run.text, job, pages, refused: possiblyIncomplete ? refused : [] });
    const summary = review ? `${possiblyIncomplete ? "possibly incomplete" : review.verdict}: ${shorten(review.summary, 90)}` : shorten(firstLine(run.text), 90);
    finishJob(job, "completed", output, summary);
  } else {
    const failure = backend.classifyFailure(run);
    output = render.renderFailure({ title: `Gemini ${label}`, failure, run, job });
    finishJob(job, "failed", output, failure.message);
    process.exitCode = 1;
  }
  write(options.json ? JSON.stringify({ job, review, refusedTools: refused, possiblyIncomplete, answer: run.text }, null, 2) : output);
}

async function handleConsult(argv, kind) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["model", "cwd", "prompt-file", "timeout-min", "resume-session"],
    listOptions: ["allow-url"],
    booleanOptions: ["json", "write", "read-only", "resume-last", "resume", "fresh", "background", "wait"],
    aliasMap: { C: "cwd", m: "model" }
  });
  if (options.fresh && (options["resume-last"] || options.resume)) {
    throw new Error("Choose either --resume or --fresh, not both.");
  }

  const backend = getBackend();
  const allowUrls = resolveAllowUrls(options, backend);
  const cwd = resolveCwd(options);
  const workspaceRoot = workspaceRootFor(cwd);
  const writeMode = kind === "task" && Boolean(options.write) && !options["read-only"];
  const request = await readRequest(cwd, options, positionals);
  const resumeSessionId = resolveResumeSession(workspaceRoot, options, backend);
  if (!request && !resumeSessionId) {
    throw new Error("Nothing to send to Gemini: give the request as text, with --prompt-file, or on stdin.");
  }
  const launch = requireLaunch(backend);

  const runRequest = {
    cwd: workspaceRoot,
    prompt: resumeSessionId
      ? buildFollowUpPrompt({ request: request || "Continue where you left off.", write: writeMode, allowUrls }, backend.prompt)
      : buildTaskPrompt({ request, write: writeMode, kind, workspaceRoot, allowUrls }, backend.prompt),
    finalInstruction: resumeSessionId ? FOLLOW_UP_FINAL_INSTRUCTION : kind === "ask" ? ASK_FINAL_INSTRUCTION : TASK_FINAL_INSTRUCTION,
    write: writeMode,
    web: true,
    allowUrls,
    structured: false,
    model: resolveModel(options),
    resumeSessionId,
    timeoutMs: resolveTimeoutMs(options, kind)
  };
  const jobFields = {
    kind,
    title: kind === "ask" ? "Gemini Ask" : writeMode ? "Gemini Task (write)" : "Gemini Task",
    summary: shorten(request || "(continue)", 90),
    workspaceRoot,
    write: writeMode,
    resumedFrom: resumeSessionId,
    backend: backend.name,
    allowUrls
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
    // The worker records its own pid when it starts the run (executeJob).
    // Writing it from here too could overwrite a status the worker had
    // already moved on; a worker that never starts is caught by reconcile().
    worker.unref();
    write(options.json ? JSON.stringify({ jobId: job.id, status: "queued" }, null, 2) : render.renderQueued(job));
    return;
  }

  const job = createJob(jobFields);
  const run = await executeJob(job, backend, { launch, ...runRequest });
  if (!run) {
    write(`Gemini job \`${job.id}\` was cancelled.\n`);
    return;
  }
  const output = finalizeConsult(job, backend, run);
  write(options.json ? JSON.stringify({ job, answer: run.text }, null, 2) : output);
}

function finalizeConsult(job, backend, run) {
  if (backend.isRunSuccessful(run)) {
    const editedFiles = job.write ? backend.touchedFiles(run, job.workspaceRoot) : [];
    const output = render.renderConsult({ job, answer: run.text, editedFiles });
    finishJob(job, "completed", output, shorten(firstLine(run.text), 90));
    return output;
  }
  const failure = backend.classifyFailure(run);
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
  const backend = getBackend(jobBackend(job));
  const launch = backend.resolveLaunch();
  if (!launch) {
    const error = backend.unavailableError();
    finishJob(job, "failed", `${error.message}\n`, error.message);
    return;
  }
  const run = await executeJob(job, backend, { launch, ...job.request });
  if (run) {
    finalizeConsult(job, backend, run);
  }
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
  let job = reference
    ? findJob(workspaceRoot, reference)
    : sessionScopedJobs(workspaceRoot, false).jobs.find((candidate) => ACTIVE_STATUSES.has(candidate.status));
  if (!job) {
    write(reference ? `No Gemini job matches "${reference}" in this repository.` : "No running Gemini job to cancel.");
    return;
  }
  // A worker that has not recorded its pid yet sees the cancel and never
  // starts Gemini; one that has is stopped below (see cancelJob).
  const { job: current, cancelled } = cancelJob(workspaceRoot, job.id);
  if (!cancelled) {
    write(`Gemini job \`${job.id}\` already finished (${current?.status ?? job.status}).`);
    return;
  }
  job = current;
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
  const candidate = findResumeCandidate(workspaceRootFor(resolveCwd(options)), getBackend());
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
