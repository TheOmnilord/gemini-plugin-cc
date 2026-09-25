import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeArgv, parseArgs, splitRawArgumentString } from "../plugins/gemini/scripts/lib/args.mjs";
import { escapeAtSigns, restoreAtSigns } from "../plugins/gemini/scripts/lib/gemini.mjs";
import { collectReviewContext, resolveReviewTarget } from "../plugins/gemini/scripts/lib/git.mjs";
import { extractJsonObject, parseReview } from "../plugins/gemini/scripts/lib/review.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPANION = path.join(ROOT, "plugins", "gemini", "scripts", "gemini-companion.mjs");
const FAKE_GEMINI = path.join(ROOT, "tests", "fixtures", "fake-gemini.mjs");

const createdDirs = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A just-killed background process may still hold a file on Windows.
    }
  }
});

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function makeRepo() {
  const dir = tempDir("gemini-cc-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(dir, "app.js"), "export function average(xs) {\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function makeEnv(extra = {}) {
  const data = tempDir("gemini-cc-data-");
  return {
    capture: path.join(data, "capture.jsonl"),
    env: {
      GEMINI_COMPANION_CLI: FAKE_GEMINI,
      GEMINI_COMPANION_DATA: data,
      GEMINI_COMPANION_MODEL: "",
      FAKE_GEMINI_CAPTURE: path.join(data, "capture.jsonl"),
      CLAUDE_CODE_SESSION_ID: "test-session",
      ...extra
    }
  };
}

function companion(args, { cwd, env, input = "" }) {
  const result = spawnSync(process.execPath, [COMPANION, ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function captures(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function argAfter(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

async function waitFor(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for condition.");
}

test("splits raw slash-command arguments", () => {
  assert.deepEqual(splitRawArgumentString(`--base main "focus on auth" the user's input`), [
    "--base",
    "main",
    "focus on auth",
    "the",
    "user's",
    "input"
  ]);
  assert.deepEqual(splitRawArgumentString("--prompt-file C:\\tmp\\brief.md"), ["--prompt-file", "C:\\tmp\\brief.md"]);
  assert.deepEqual(normalizeArgv(["--timeout-min 9 --base main"]), ["--timeout-min", "9", "--base", "main"]);
  assert.deepEqual(normalizeArgv(["--write", "--model", "pro"]), ["--write", "--model", "pro"]);
});

test("parses options, aliases and positionals", () => {
  const { options, positionals } = parseArgs(["-m", "pro", "--write", "--timeout-min=5", "fix", "it"], {
    valueOptions: ["model", "timeout-min"],
    booleanOptions: ["write"],
    aliasMap: { m: "model" }
  });
  assert.deepEqual(options, { model: "pro", write: true, "timeout-min": "5" });
  assert.deepEqual(positionals, ["fix", "it"]);
});

test("extracts and normalizes review JSON", () => {
  assert.deepEqual(extractJsonObject('Here you go:\n```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('prefix {"a": 2} suffix'), { a: 2 });
  assert.equal(extractJsonObject("no json here"), null);

  const review = parseReview(
    JSON.stringify({
      verdict: "bogus",
      summary: " s ",
      findings: [
        { severity: "LOW", title: "b", line_start: 3 },
        { severity: "critical", title: "a", confidence: 7 }
      ]
    })
  );
  assert.equal(review.verdict, "needs-attention");
  assert.deepEqual(review.findings.map((finding) => finding.title), ["a", "b"]);
  assert.equal(review.findings[0].confidence, 1);
  assert.equal(review.findings[1].lineEnd, 3);
});

test("escapes at-signs for transport and restores them", () => {
  const text = "@Override user@example.com @/components \\@x";
  assert.ok(!/(?<!\\)@/.test(escapeAtSigns(text)));
  assert.equal(restoreAtSigns("\\@param"), "@param");
});

test("collects working-tree context with untracked files and lockfiles", () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, "app.js"), "// @param xs numbers\n");
  fs.writeFileSync(path.join(repo, "notes.md"), "Contains ```fences``` inside.\n");
  fs.writeFileSync(path.join(repo, "package-lock.json"), '{"lockfileVersion": 3}\n');
  git(repo, "add", "package-lock.json");

  const target = resolveReviewTarget(repo, {});
  assert.equal(target.mode, "working-tree");
  const context = collectReviewContext(repo, target);
  assert.equal(context.empty, false);
  assert.match(context.content, /## Unstaged diff[\s\S]*@param xs numbers/);
  assert.match(context.content, /### notes\.md \(new file\)\n````/);
  assert.match(context.content, /lockfile diff omitted/);
  assert.deepEqual(context.lockfiles, ["package-lock.json"]);
});

test("truncates oversized diffs per file", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "big.txt"), `${"line of text\n".repeat(4000)}`);
  git(repo, "add", "big.txt");
  const context = collectReviewContext(repo, { mode: "working-tree", label: "working tree diff" }, { maxInlineBytes: 16 * 1024 });
  assert.deepEqual(context.truncatedFiles, ["big.txt"]);
  assert.match(context.content, /diff truncated here/);
  assert.ok(context.content.length < 24 * 1024);
});

test("picks a branch diff when the tree is clean", () => {
  const repo = makeRepo();
  git(repo, "checkout", "-q", "-b", "feature");
  fs.appendFileSync(path.join(repo, "app.js"), "export const answer = 42;\n");
  git(repo, "commit", "-q", "-am", "feature");
  const target = resolveReviewTarget(repo, {});
  assert.deepEqual(target, { mode: "branch", baseRef: "main", label: "branch diff against main" });
  const context = collectReviewContext(repo, target);
  assert.deepEqual(context.changedFiles, ["app.js"]);
  assert.match(context.content, /## Commit log[\s\S]*feature/);
});

test("review runs Gemini read-only and renders sorted findings", () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, "app.js"), "// @param xs numbers\n");
  const { env, capture } = makeEnv();

  const result = companion(["review", "--timeout-min 9 focus on edge cases"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Gemini Review/);
  assert.match(result.stdout, /\*\*Focus:\*\* focus on edge cases/);
  assert.match(result.stdout, /### 1\. \[high\] Empty list crashes average\(\)/);
  assert.match(result.stdout, /`app\.js:2-3`/);
  assert.match(result.stdout, /The @param doc/);
  assert.match(result.stdout, /1,200 in \/ 34 out tokens/);

  const [call] = captures(capture);
  assert.equal(argAfter(call.args, "--approval-mode"), "default");
  assert.equal(argAfter(call.args, "--output-format"), "stream-json");
  assert.ok(argAfter(call.args, "--policy").endsWith(path.join("policies", "review.toml")));
  assert.match(argAfter(call.args, "--session-id"), /^[0-9a-f-]{36}$/);
  assert.match(call.prompt, /\\@param xs numbers/);
  assert.match(call.prompt, /Transport note/);
  assert.ok(!/(?<!\\)@/.test(call.prompt));
  assert.equal(path.resolve(call.cwd).toLowerCase(), fs.realpathSync.native(repo).toLowerCase());
});

test("review reports when there is nothing to review", () => {
  const repo = makeRepo();
  const { env } = makeEnv();
  const result = companion(["review", "--scope working-tree"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Nothing for a Gemini review: the working tree is clean/);
});

test("ask can resume the previous Gemini conversation", () => {
  const repo = makeRepo();
  const { env, capture } = makeEnv();

  const first = companion(["ask", "--timeout-min", "9"], { cwd: repo, env, input: "Is average() safe? It's used by the \"stats\" page.\n" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /# Gemini's answer\n\nAnswer from fake Gemini\. Resumed: false\./);

  const candidate = JSON.parse(companion(["resume-candidate", "--json"], { cwd: repo, env }).stdout);
  assert.equal(candidate.available, true);
  assert.equal(candidate.candidate.kind, "ask");

  const second = companion(["ask", "--resume-last"], { cwd: repo, env, input: "What about NaN inputs?" });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Resumed: true/);

  const [firstCall, secondCall] = captures(capture);
  assert.match(firstCall.prompt, /It's used by the "stats" page\./);
  assert.equal(argAfter(firstCall.args, "--approval-mode"), "default");
  assert.equal(argAfter(secondCall.args, "--resume"), argAfter(firstCall.args, "--session-id"));
  assert.match(secondCall.prompt, /<follow_up>\nWhat about NaN inputs\?\n<\/follow_up>/);
});

test("task --write uses auto_edit and reports edited files", () => {
  const repo = makeRepo();
  const { env, capture } = makeEnv();
  const result = companion(["task", "--write", "--model", "pro"], { cwd: repo, env, input: "Fix the empty-list bug." });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Gemini task result \(write mode\)/);
  assert.match(result.stdout, /\*\*Files Gemini edited:\*\*\n- `fixed\.js`/);
  const [call] = captures(capture);
  assert.equal(argAfter(call.args, "--approval-mode"), "auto_edit");
  assert.equal(argAfter(call.args, "--model"), "pro");
  assert.match(call.prompt, /You may create and edit files inside this repository/);
});

test("auth failures explain how to sign in", () => {
  const repo = makeRepo();
  const { env } = makeEnv({ FAKE_GEMINI_MODE: "auth" });
  const result = companion(["ask"], { cwd: repo, env, input: "hello" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not signed in/);
  assert.match(result.stdout, /Sign in with Google/);
});

test("background tasks can be followed with status and result", async () => {
  const repo = makeRepo();
  const { env } = makeEnv();
  const started = companion(["task", "--background"], { cwd: repo, env, input: "Investigate average()." });
  assert.equal(started.status, 0, started.stderr);
  const jobId = /as `([^`]+)`/.exec(started.stdout)?.[1];
  assert.ok(jobId, started.stdout);

  await waitFor(() => JSON.parse(companion(["status", jobId, "--json"], { cwd: repo, env }).stdout).status === "completed");
  const status = companion(["status"], { cwd: repo, env });
  assert.match(status.stdout, new RegExp(`\\| \`${jobId}\` \\| task \\| completed \\|`));
  const result = companion(["result", jobId], { cwd: repo, env });
  assert.match(result.stdout, /Answer from fake Gemini/);
});

test("cancel stops a running background job", async () => {
  const repo = makeRepo();
  const { env } = makeEnv({ FAKE_GEMINI_MODE: "slow" });
  const started = companion(["task", "--background"], { cwd: repo, env, input: "Take your time." });
  const jobId = /as `([^`]+)`/.exec(started.stdout)?.[1];
  assert.ok(jobId, started.stdout);

  const running = await waitFor(() => {
    const job = JSON.parse(companion(["status", jobId, "--json"], { cwd: repo, env }).stdout);
    return job.status === "running" && job.geminiPid ? job : null;
  });
  const cancelled = companion(["cancel", jobId], { cwd: repo, env });
  assert.match(cancelled.stdout, /Cancelled Gemini job/);
  await waitFor(() => {
    try {
      process.kill(running.geminiPid, 0);
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(JSON.parse(companion(["status", jobId, "--json"], { cwd: repo, env }).stdout).status, "cancelled");
});

test("setup reports the CLI and sign-in state", () => {
  const { env } = makeEnv();
  const result = companion(["setup", "--json"], { cwd: os.tmpdir(), env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.gemini.installed, true);
  assert.equal(report.gemini.version, "0.0.0-fake");
  assert.equal(typeof report.auth.configured, "boolean");
});
