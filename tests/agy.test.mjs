// Tests for the default Antigravity CLI (agy) backend, run against a fake agy.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { plainFileLinks, resolveAgyModel } from "../plugins/gemini/scripts/lib/agy.mjs";
import { argAfter, captures, companion, companionAsync, makeRepo, ROOT, tempDir, waitFor } from "./helpers.mjs";

const FAKE_AGY = path.join(ROOT, "tests", "fixtures", "fake-agy.mjs");
const FAKE_GEMINI = path.join(ROOT, "tests", "fixtures", "fake-gemini.mjs");
const GUARD = path.join(ROOT, "plugins", "gemini", "scripts", "agy-guard.mjs");

function makeEnv(extra = {}) {
  const data = tempDir("gemini-cc-agy-data-");
  return {
    data,
    profile: path.join(data, "agy-profile"),
    capture: path.join(data, "capture.jsonl"),
    env: {
      GEMINI_COMPANION_BACKEND: "",
      GEMINI_COMPANION_AGY: FAKE_AGY,
      GEMINI_COMPANION_DATA: data,
      GEMINI_COMPANION_MODEL: "",
      FAKE_AGY_CAPTURE: path.join(data, "capture.jsonl"),
      CLAUDE_CODE_SESSION_ID: "test-session",
      ...extra
    }
  };
}

function samePath(actual, expected) {
  assert.equal(path.resolve(actual).toLowerCase(), path.resolve(expected).toLowerCase());
}

function conversationOf(repo, env, kind) {
  const jobs = JSON.parse(companion(["status", "--all", "--json"], { cwd: repo, env }).stdout);
  return jobs.find((job) => job.kind === kind)?.geminiSessionId;
}

test("maps model aliases to agy models", () => {
  assert.equal(resolveAgyModel(""), "gemini-3.8-flash-medium");
  assert.equal(resolveAgyModel("pro"), "gemini-3.1-pro-high");
  assert.equal(resolveAgyModel("flash-lite"), "gemini-3.8-flash-low");
  assert.equal(resolveAgyModel("gemini-3.7-flash-high"), "gemini-3.7-flash-high");
});

test("turns file:// links into repository-relative references", () => {
  const repo = path.resolve(os.tmpdir(), "links-repo");
  const url = pathToFileURL(path.join(repo, "src", "app.js")).href;
  assert.equal(plainFileLinks(`See [app.js](${url}#L6-L9).`, repo), "See `src/app.js:6-9`.");
  assert.equal(plainFileLinks(`[\`average\`](${url}#L7) fails`, repo), "`average` (`src/app.js:7`) fails");
  assert.equal(plainFileLinks("[docs](https://example.com)", repo), "[docs](https://example.com)");
});

test("review runs through agy read-only, without web, with the review schema", () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, "app.js"), "// @param xs numbers\n");
  const { env, capture, profile } = makeEnv();

  const result = companion(["review", "--timeout-min 9 focus on edge cases"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\*\*Verdict:\*\* needs attention/);
  assert.match(result.stdout, /### 1\. \[high\] Empty list crashes average\(\)/);
  assert.match(result.stdout, /`app\.js:2-3`/);
  assert.match(result.stdout, /The @param doc/);
  assert.match(result.stdout, /gemini-3\.8-flash-medium · .* · 2,100 in \/ 42 out tokens/);

  const [call] = captures(capture);
  assert.equal(argAfter(call.args, "-p"), "");
  assert.equal(argAfter(call.args, "--input-format"), "stream-json");
  assert.equal(argAfter(call.args, "--output-format"), "stream-json");
  assert.equal(argAfter(call.args, "--agent"), "gemini-cc");
  assert.equal(argAfter(call.args, "--model"), "gemini-3.8-flash-medium");
  assert.ok(argAfter(call.args, "--json-schema").endsWith(path.join("schemas", "review-output.schema.json")));
  assert.ok(call.args.includes("--disable-slash-commands"));
  assert.equal(call.env.mode, "read-only");
  assert.equal(call.env.web, "0");
  assert.equal(call.env.noColor, "1");
  samePath(call.env.home, profile);
  samePath(call.env.userProfile, profile);
  samePath(call.env.profile, profile);
  assert.equal(call.profileReady, true);
  samePath(call.cwd, fs.realpathSync.native(repo));
  // agy reads @ literally, so the prompt goes out unescaped.
  assert.match(call.message, /\/\/ @param xs numbers/);
  assert.doesNotMatch(call.message, /Transport note|\\@/);
  assert.match(call.message, /perform the review now/);
  assert.match(call.message, /no web access in this review/);
  assert.doesNotMatch(result.stdout, /Possibly incomplete/);
});

test("an empty review after a refused tool call is flagged as possibly incomplete", () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, "app.js"), "// see https://example.com/spec\n");
  const { env } = makeEnv({ FAKE_AGY_MODE: "web-refused" });

  const result = companion(["adversarial-review"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Possibly incomplete:.*\(`read_url_content`\)/);
  assert.match(result.stdout, /\*\*Verdict:\*\* approve \(possibly incomplete\)/);
  assert.doesNotMatch(result.stdout, /No material findings/);

  const json = JSON.parse(companion(["review", "--json"], { cwd: repo, env }).stdout);
  assert.equal(json.possiblyIncomplete, true);
  assert.deepEqual(json.refusedTools, ["read_url_content"]);
  const jobs = JSON.parse(companion(["status", "--all", "--json"], { cwd: repo, env }).stdout);
  assert.equal(jobs.length, 2);
  jobs.forEach((job) => assert.match(job.resultSummary, /^possibly incomplete:/));
});

test("a review that carries on after a refused tool call is shown as usual", () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, "app.js"), "// changed\n");
  const { env } = makeEnv({ FAKE_AGY_MODE: "web-refused-then-review" });

  const result = companion(["review"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /### 1\. \[high\] Empty list crashes average\(\)/);
  assert.doesNotMatch(result.stdout, /Possibly incomplete/);
  const json = JSON.parse(companion(["review", "--json"], { cwd: repo, env }).stdout);
  assert.equal(json.possiblyIncomplete, false);
  assert.deepEqual(json.refusedTools, ["read_url_content"]);
});

test("a conversation is busy while a run that continues it is still going", async () => {
  const repo = makeRepo();
  const { env } = makeEnv();
  assert.equal(companion(["ask"], { cwd: repo, env, input: "Is average() safe?" }).status, 0);

  // A background run continues the conversation and takes its time.
  const slow = { ...env, FAKE_AGY_MODE: "slow" };
  const started = companion(["task", "--background", "--resume-last"], { cwd: repo, env: slow, input: "Dig deeper." });
  const jobId = /as `([^`]+)`/.exec(started.stdout)?.[1];
  assert.ok(jobId, started.stdout);
  const running = await waitFor(() => {
    const job = JSON.parse(companion(["status", jobId, "--json"], { cwd: repo, env }).stdout);
    return job.status === "running" && job.geminiPid ? job : null;
  });
  try {
    const candidate = JSON.parse(companion(["resume-candidate", "--json"], { cwd: repo, env }).stdout);
    assert.equal(candidate.available, false);
    assert.equal(candidate.busyJob, jobId);
    const second = companion(["ask", "--resume-last"], { cwd: repo, env, input: "And NaN?" });
    assert.equal(second.status, 1);
    assert.match(second.stderr, new RegExp(`${jobId} is still running in that conversation`));
  } finally {
    companion(["cancel", jobId], { cwd: repo, env });
    await waitFor(() => {
      try {
        process.kill(running.geminiPid, 0);
        return false;
      } catch {
        return true;
      }
    });
  }
});

test("ask can continue the same agy conversation, with web access", () => {
  const repo = makeRepo();
  const { env, capture } = makeEnv();

  const first = companion(["ask"], { cwd: repo, env, input: "Is average() safe?" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /# Gemini's answer\n\nAnswer from fake agy\. Resumed: false\./);
  assert.equal(JSON.parse(companion(["resume-candidate", "--json"], { cwd: repo, env }).stdout).available, true);

  const second = companion(["ask", "--resume-last"], { cwd: repo, env, input: "What about NaN inputs?" });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Resumed: true/);

  const [firstCall, secondCall] = captures(capture);
  assert.equal(firstCall.env.web, "1");
  assert.equal(argAfter(firstCall.args, "--conversation"), null);
  assert.equal(argAfter(secondCall.args, "--conversation"), conversationOf(repo, env, "ask"));
  assert.match(secondCall.message, /These rules apply to this turn[\s\S]*Read-only session/);
  assert.match(secondCall.message, /<follow_up>\nWhat about NaN inputs\?\n<\/follow_up>/);
});

test("task --write lets agy edit, lists the files and cleans up file links", () => {
  const repo = makeRepo();
  const { env, capture } = makeEnv();
  const result = companion(["task", "--write", "--model", "pro"], { cwd: repo, env, input: "Fix the empty-list bug." });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Gemini task result \(write mode\)/);
  assert.match(result.stdout, /Fixed the bug in `fixed\.js:2`\./);
  assert.match(result.stdout, /\*\*Files Gemini edited:\*\*\n- `fixed\.js`/);

  const [call] = captures(capture);
  assert.equal(call.env.mode, "write");
  assert.equal(argAfter(call.args, "--model"), "gemini-3.1-pro-high");
  assert.equal(argAfter(call.args, "--json-schema"), null);
  assert.match(call.message, /You may create and edit files inside this repository/);
  assert.doesNotMatch(call.message, /Build and dependency files/);
});

test("a read-only conversation can continue in write mode", () => {
  const repo = makeRepo();
  const { env, capture } = makeEnv();
  assert.equal(companion(["ask"], { cwd: repo, env, input: "Where is the bug?" }).status, 0);
  const result = companion(["task", "--write", "--resume-last"], { cwd: repo, env, input: "Apply your fix." });
  assert.equal(result.status, 0, result.stderr);

  const [, resumed] = captures(capture);
  assert.equal(argAfter(resumed.args, "--conversation"), conversationOf(repo, env, "ask"));
  assert.equal(argAfter(resumed.args, "--agent"), "gemini-cc");
  assert.equal(resumed.env.mode, "write");
  assert.match(resumed.message, /These rules apply to this turn[\s\S]*You may create and edit files/);
});

test("the private agy profile carries the agent, the guard and the deny rules", () => {
  const repo = makeRepo();
  const { env, profile } = makeEnv();
  const settingsFile = path.join(profile, ".gemini", "antigravity-cli", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ keptByAgy: 1, permissions: { allow: ["command(*)"] } }));
  assert.equal(companion(["ask"], { cwd: repo, env, input: "hello" }).status, 0);

  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(settings.keptByAgy, 1);
  // File reads are opened for the profile's brain folder only, by its real path.
  const brain = fs.realpathSync.native(path.join(profile, ".gemini", "antigravity-cli", "brain"));
  assert.deepEqual(settings.permissions, { allow: ["read_url(*)", `read_file(${brain})`], deny: ["command(*)", "unsandboxed(*)", "execute_url(*)", "mcp(*)"] });

  const configDir = path.join(profile, ".gemini", "config");
  const hooks = JSON.parse(fs.readFileSync(path.join(configDir, "hooks.json"), "utf8"));
  assert.equal(hooks["gemini-cc-guard"].PreToolUse[0].matcher, "*");
  assert.equal(hooks["gemini-cc-guard"].PreToolUse[0].hooks[0].command, "node gemini-cc-guard.mjs");
  assert.equal(fs.readFileSync(path.join(configDir, "gemini-cc-guard.mjs"), "utf8"), fs.readFileSync(GUARD, "utf8"));
  const agent = fs.readFileSync(path.join(configDir, "agents", "gemini-cc.md"), "utf8");
  assert.match(agent, /^name: gemini-cc$/m);
  assert.match(agent, /^tools: \[view_file, list_dir, grep_search, find_by_name, write_to_file, replace_file_content, multi_replace_file_content, search_web, read_url_content, finish\]$/m);
});

test("setup reports agy, the sign-in and the models, and runs a live check", () => {
  const { env } = makeEnv();
  const result = companion(["setup", "--check", "--json"], { cwd: os.tmpdir(), env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.backend, "agy");
  assert.equal(report.agy.version, "1.2.11");
  assert.equal(report.signIn.signedIn, true);
  assert.equal(report.model.resolved, "gemini-3.8-flash-medium");
  assert.equal(report.model.available, true);
  assert.equal(report.live.ok, true);
  assert.equal(report.ready, true);

  const text = companion(["setup"], { cwd: os.tmpdir(), env }).stdout;
  assert.match(text, /\*\*Backend:\*\* Antigravity CLI/);
  assert.match(text, /\*\*Sign-in:\*\* signed in/);
});

test("setup and runs explain a signed-out agy", () => {
  const repo = makeRepo();
  const { env } = makeEnv({ FAKE_AGY_MODE: "signed-out" });
  const report = JSON.parse(companion(["setup", "--json"], { cwd: repo, env }).stdout);
  assert.equal(report.signIn.signedIn, false);
  assert.equal(report.ready, false);
  assert.match(report.nextSteps.join("\n"), /run `agy`, sign in with your Google account/);

  const result = companion(["ask"], { cwd: repo, env, input: "hello" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not signed in/);
});

test("setup explains how to install agy when it is missing", () => {
  const empty = tempDir("gemini-cc-no-agy-");
  const nodeOnly = path.dirname(process.execPath);
  // Windows spells it Path; both spellings are set so neither leaks the real one.
  const { env } = makeEnv({ GEMINI_COMPANION_AGY: "", PATH: nodeOnly, Path: nodeOnly, LOCALAPPDATA: empty, HOME: empty, USERPROFILE: empty });
  const report = JSON.parse(companion(["setup", "--json"], { cwd: os.tmpdir(), env }).stdout);
  assert.equal(report.agy.installed, false);
  assert.match(report.nextSteps.join("\n"), /Install the Antigravity CLI: `(irm|curl) /);

  const result = companion(["ask"], { cwd: os.tmpdir(), env, input: "hello" });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /The Antigravity CLI \(agy\) was not found/);
});

test("a run stopped by a cancel is reported as cancelled, not as a failure", () => {
  const repo = makeRepo();
  const { env } = makeEnv({ FAKE_AGY_MODE: "cancelled-mid-run" });
  const result = companion(["task"], { cwd: repo, env, input: "Investigate average()." });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Gemini job `task-[^`]+` was cancelled\./);
  assert.doesNotMatch(result.stdout, /failed/);
  const [job] = JSON.parse(companion(["status", "--all", "--json"], { cwd: repo, env }).stdout);
  assert.equal(job.status, "cancelled");
  assert.equal(job.resultSummary, "Cancelled by user.");
});

test("agy failures are classified", () => {
  const repo = makeRepo();
  const cases = [
    [{ FAKE_AGY_MODE: "quota" }, [], /quota or usage limit/],
    [{ FAKE_AGY_MODE: "denied" }, [], /needed an action this run does not allow \(RunCommand\)/],
    [{}, ["--model", "gemini-9-ultra"], /does not offer the requested model/]
  ];
  for (const [extra, args, pattern] of cases) {
    const result = companion(["ask", ...args], { cwd: repo, env: makeEnv(extra).env, input: "hello" });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, pattern);
  }
  const report = JSON.parse(companion(["setup", "--json"], { cwd: repo, env: makeEnv({ GEMINI_COMPANION_MODEL: "gemini-9-ultra" }).env }).stdout);
  assert.equal(report.model.available, false);
  assert.equal(report.ready, false);
});

test("background agy tasks finish, and cancel stops agy", async () => {
  const repo = makeRepo();
  const { env } = makeEnv();
  const started = companion(["task", "--background"], { cwd: repo, env, input: "Investigate average()." });
  const jobId = /as `([^`]+)`/.exec(started.stdout)?.[1];
  assert.ok(jobId, started.stdout);
  await waitFor(() => JSON.parse(companion(["status", jobId, "--json"], { cwd: repo, env }).stdout).status === "completed");
  assert.match(companion(["result", jobId], { cwd: repo, env }).stdout, /Answer from fake agy/);

  const slow = makeEnv({ FAKE_AGY_MODE: "slow" }).env;
  const slowJob = /as `([^`]+)`/.exec(companion(["task", "--background"], { cwd: repo, env: slow, input: "Take your time." }).stdout)?.[1];
  const running = await waitFor(() => {
    const job = JSON.parse(companion(["status", slowJob, "--json"], { cwd: repo, env: slow }).stdout);
    return job.status === "running" && job.geminiPid ? job : null;
  });
  assert.match(companion(["cancel", slowJob], { cwd: repo, env: slow }).stdout, /Cancelled Gemini job/);
  await waitFor(() => {
    try {
      process.kill(running.geminiPid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test("conversations are never resumed across backends", () => {
  const repo = makeRepo();
  const { env, data } = makeEnv();
  const geminiEnv = { ...env, GEMINI_COMPANION_BACKEND: "gemini-cli", GEMINI_COMPANION_CLI: FAKE_GEMINI, GEMINI_CLI_HOME: tempDir("gemini-cc-home-"), FAKE_GEMINI_CAPTURE: path.join(data, "gemini.jsonl") };
  assert.equal(companion(["ask"], { cwd: repo, env: geminiEnv, input: "hello" }).status, 0);
  assert.equal(JSON.parse(companion(["resume-candidate", "--json"], { cwd: repo, env: geminiEnv }).stdout).available, true);
  assert.equal(JSON.parse(companion(["resume-candidate", "--json"], { cwd: repo, env }).stdout).available, false);
});

test("an unknown backend name is rejected", () => {
  const { env } = makeEnv({ GEMINI_COMPANION_BACKEND: "bard" });
  const result = companion(["ask"], { cwd: os.tmpdir(), env, input: "hello" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown GEMINI_COMPANION_BACKEND "bard"/);
});

test("--context-url adds fetched pages to the review; Gemini still gets no web access", async () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, "app.js"), "// changed\n");
  const { env, capture } = makeEnv();
  const server = http.createServer((request, response) => {
    if (request.url === "/spec") {
      response.writeHead(200, { "content-type": "text/html" }).end("<h1>Spec</h1><p>average() of an empty list returns 0.</p>");
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await companionAsync(["review", "--context-url", `${base}/spec#empty`], { cwd: repo, env });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`**Reference pages:** ${base}/spec`), result.stdout);
    const [call] = captures(capture);
    assert.match(call.message, /<reference_material>[\s\S]*untrusted[\s\S]*<page url="[^"]+\/spec">\n# Spec\naverage\(\) of an empty list returns 0\.\n<\/page>/);
    assert.match(call.message, /no web access in this review[\s\S]*the diff, the repository and the reference material/);
    assert.equal(call.env.web, "0");
    assert.equal(call.env.webAllow, "[]");

    // A page that cannot be fetched stops the review before Gemini starts.
    const missing = await companionAsync(["review", "--context-url", `${base}/gone`], { cwd: repo, env });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Could not fetch .*\/gone for the review: HTTP 404/);
    assert.equal(captures(capture).length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("--allow-url hands the guard the exact addresses, for reviews and asks", () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, "app.js"), "// changed\n");
  const { env, capture } = makeEnv();

  const review = companion(["review", "--allow-url", "https://docs.example.com/spec#x", "--allow-url=http://localhost:3000"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);
  assert.match(review.stdout, /\*\*Gemini may open:\*\* https:\/\/docs\.example\.com\/spec, http:\/\/localhost:3000\//);
  const ask = companion(["ask", "--allow-url", "https://docs.example.com/spec"], { cwd: repo, env, input: "What does the spec say?" });
  assert.equal(ask.status, 0, ask.stderr);

  const [reviewCall, askCall] = captures(capture);
  assert.deepEqual(JSON.parse(reviewCall.env.webAllow), ["https://docs.example.com/spec", "http://localhost:3000/"]);
  assert.equal(reviewCall.env.web, "0");
  assert.match(reviewCall.message, /<web_access>[\s\S]*- https:\/\/docs\.example\.com\/spec\n- http:\/\/localhost:3000\/\nWeb search and every other address are refused/);
  assert.match(reviewCall.message, /Your only web access in this review is reading the exact addresses/);
  assert.deepEqual(JSON.parse(askCall.env.webAllow), ["https://docs.example.com/spec"]);
  assert.equal(askCall.env.web, "1");
  assert.match(askCall.message, /You may open exactly these web addresses[^\n]*https:\/\/docs\.example\.com\/spec/);

  // Off unless asked for.
  const plain = companion(["ask"], { cwd: repo, env, input: "hello" });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(captures(capture).at(-1).env.webAllow, "[]");
  assert.doesNotMatch(captures(capture).at(-1).message, /You may open exactly/);
});

test("bad --context-url and --allow-url addresses are rejected before Gemini starts", () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, "app.js"), "// changed\n");
  const { env, capture } = makeEnv();
  for (const [args, pattern] of [
    [["review", "--context-url", "file:///etc/passwd"], /only accepts http and https/],
    [["review", "--allow-url", "https://user:pw@example.com/"], /user name or password/],
    [["review", "--context-url"], /Missing value for --context-url/]
  ]) {
    const result = companion(args, { cwd: repo, env });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, pattern);
  }
  const cli = companion(["review", "--allow-url", "https://example.com/"], { cwd: repo, env: { ...env, GEMINI_COMPANION_BACKEND: "gemini-cli" } });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /--allow-url needs the Antigravity CLI backend/);
  assert.equal(fs.existsSync(capture), false);
});
