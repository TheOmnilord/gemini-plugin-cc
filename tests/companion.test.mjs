// Tests for the shared companion code and the opt-in Gemini CLI backend.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { normalizeArgv, parseArgs, splitRawArgumentString } from "../plugins/gemini/scripts/lib/args.mjs";
import { escapeAtSigns, isSupportedGeminiVersion, restoreAtSigns } from "../plugins/gemini/scripts/lib/gemini.mjs";
import { collectReviewContext, gitFilterOverrides, resolveReviewTarget } from "../plugins/gemini/scripts/lib/git.mjs";
import { extractJsonObject, parseReview, refusedTools, stoppedAfterRefusal } from "../plugins/gemini/scripts/lib/review.mjs";
import { argAfter, argsAfter, captures, companion, git, makeRepo, ROOT, tempDir, waitFor } from "./helpers.mjs";

const FAKE_GEMINI = path.join(ROOT, "tests", "fixtures", "fake-gemini.mjs");

function makeEnv(extra = {}) {
  const data = tempDir("gemini-cc-data-");
  // A private GEMINI_CLI_HOME keeps the developer's own ~/.gemini out of the tests.
  const geminiHome = tempDir("gemini-cc-home-");
  return {
    capture: path.join(data, "capture.jsonl"),
    geminiHome,
    env: {
      GEMINI_COMPANION_BACKEND: "gemini-cli",
      GEMINI_COMPANION_CLI: FAKE_GEMINI,
      GEMINI_COMPANION_DATA: data,
      GEMINI_COMPANION_MODEL: "",
      GEMINI_CLI_HOME: geminiHome,
      GEMINI_CLI_TRUST_WORKSPACE: "",
      FAKE_GEMINI_CAPTURE: path.join(data, "capture.jsonl"),
      CLAUDE_CODE_SESSION_ID: "test-session",
      ...extra
    }
  };
}

function policyNames(args) {
  return argsAfter(args, "--policy").map((file) => path.basename(file));
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
  // A quote may also open an option's value.
  assert.deepEqual(splitRawArgumentString(`--context-url="https://example.com/a b" --base='main' --model=pro`), [
    "--context-url=https://example.com/a b",
    "--base=main",
    "--model=pro"
  ]);
  // An apostrophe later in an option's value stays literal.
  assert.deepEqual(splitRawArgumentString(`--note=it's fine`), ["--note=it's", "fine"]);
  assert.deepEqual(splitRawArgumentString(`focus=it's "quoted"`), ["focus=it's", "quoted"]);
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

  // An echoed transport escape (\@) is not valid JSON; an escaped backslash (\\@) is.
  assert.equal(parseReview('{"verdict":"approve","summary":"Keep \\@Override and \\@param","findings":[]}').summary, "Keep @Override and @param");
  assert.equal(parseReview('{"verdict":"approve","summary":"Keep \\\\@Override","findings":[]}').summary, "Keep \\@Override");
});

test("checks the minimum Gemini CLI version", () => {
  assert.equal(isSupportedGeminiVersion("0.41.0"), true);
  assert.equal(isSupportedGeminiVersion("0.61.0-nightly.20260925"), true);
  assert.equal(isSupportedGeminiVersion("1.0.0"), true);
  assert.equal(isSupportedGeminiVersion("0.40.9"), false);
  assert.equal(isSupportedGeminiVersion("unknown"), null);
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

test("an untracked link to a network share is named without being resolved", { skip: process.platform !== "win32" }, () => {
  const repo = makeRepo();
  try {
    fs.symlinkSync("\\\\attacker.example\\share", path.join(repo, "share"), "dir");
  } catch {
    return; // Creating symlinks needs extra rights on some Windows setups.
  }
  const started = Date.now();
  const context = collectReviewContext(repo, { mode: "working-tree", label: "working tree diff" });
  // Resolving it would wait on the network; the check reads the link instead.
  assert.ok(Date.now() - started < 5000);
  assert.match(context.content, /- share: what lies behind this link is not shown/);
});

test("untracked links out of the repository are not read into the review", () => {
  const repo = makeRepo();
  const outside = tempDir("gemini-cc-outside-");
  fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE-SECRET\n");
  // A link to a folder (a junction on Windows), whose files git lists as untracked.
  fs.symlinkSync(outside, path.join(repo, "linked"), "junction");
  fs.writeFileSync(path.join(repo, "inside.md"), "INSIDE-TEXT\n");
  let fileLink = false;
  try {
    // Links to files need extra rights on Windows; tested where they can be made.
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "notes.txt"), "file");
    fs.symlinkSync(path.join(repo, "inside.md"), path.join(repo, "alias.md"), "file");
    fileLink = true;
  } catch {
    // Not permitted here.
  }

  const context = collectReviewContext(repo, { mode: "working-tree", label: "working tree diff" });
  // Neither the content nor the names of what lies behind a link go in.
  assert.doesNotMatch(context.content, /OUTSIDE-SECRET|secret\.txt/);
  assert.match(context.content, /INSIDE-TEXT/);
  assert.match(context.content, /\?\? linked \(a link that leads out of the repository\)/);
  assert.match(context.content, /## Links out of the repository\n\n- linked: what lies behind this link is not shown/);
  assert.ok(context.changedFiles.includes("linked"));
  assert.ok(!context.changedFiles.some((file) => file.startsWith("linked/")));
  if (fileLink) {
    assert.match(context.content, /- notes\.txt: what lies behind this link is not shown/);
    assert.match(context.content, /### alias\.md \(new file\)\n```\nINSIDE-TEXT/);
  }
});

test("tracked files behind a folder replaced by a link are not diffed", () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, "docs"));
  fs.writeFileSync(path.join(repo, "docs", "app.txt"), "tracked\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "docs");
  const outside = tempDir("gemini-cc-outside-");
  fs.writeFileSync(path.join(outside, "app.txt"), "OUTSIDE-SECRET\n");
  fs.rmSync(path.join(repo, "docs"), { recursive: true });
  fs.symlinkSync(outside, path.join(repo, "docs"), "junction");
  fs.appendFileSync(path.join(repo, "app.js"), "// changed\n");

  const context = collectReviewContext(repo, { mode: "working-tree", label: "working tree diff" });
  assert.doesNotMatch(context.content, /OUTSIDE-SECRET/);
  assert.match(context.content, /## Unstaged diff[\s\S]*\/\/ changed/);
  assert.match(context.content, /- docs: what lies behind this link is not shown/);
});

test("collecting a review never runs a command set as core.fsmonitor", () => {
  const repo = makeRepo();
  git(repo, "config", "core.fsmonitor", "echo ran > fsmonitor-ran.txt");
  fs.appendFileSync(path.join(repo, "app.js"), "// changed\n");
  // Control: plain git status runs it.
  spawnSync("git", ["status"], { cwd: repo, encoding: "utf8" });
  const marker = path.join(repo, "fsmonitor-ran.txt");
  if (!fs.existsSync(marker)) {
    return; // This git does not run fsmonitor commands here; nothing to prove.
  }
  fs.rmSync(marker);
  collectReviewContext(repo, { mode: "working-tree", label: "working tree diff" });
  assert.equal(fs.existsSync(marker), false);
});

test("collecting a review never runs a clean filter", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "notes.md"), "notes\n");
  fs.writeFileSync(path.join(repo, ".gitattributes"), "app.js filter=norm\nnotes.md filter=x=y\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "attributes");
  // Filters whose commands could be scripts Gemini edited: a plain one, one
  // whose name contains "=", and one that looks like Git LFS on its first line.
  git(repo, "config", "filter.norm.clean", "echo norm >> filter-ran.txt; cat");
  git(repo, "config", "filter.norm.required", "true");
  git(repo, "config", "filter.x=y.clean", "echo x=y >> filter-ran.txt; cat");
  git(repo, "config", "filter.lfs.clean", "git-lfs clean -- %f\necho lfs >> filter-ran.txt");
  fs.appendFileSync(path.join(repo, "app.js"), "// changed\n");
  fs.appendFileSync(path.join(repo, "notes.md"), "more\n");
  // Control: plain git diff runs them.
  spawnSync("git", ["diff"], { cwd: repo, encoding: "utf8" });
  const marker = path.join(repo, "filter-ran.txt");
  assert.match(fs.readFileSync(marker, "utf8"), /norm[\s\S]*x=y|x=y[\s\S]*norm/);
  fs.rmSync(marker);

  const context = collectReviewContext(repo, { mode: "working-tree", label: "working tree diff" });
  assert.equal(fs.existsSync(marker), false);
  assert.match(context.content, /\/\/ changed/);
  assert.match(context.content, /\+more/);
  const keys = gitFilterOverrides(repo).map(([key]) => key);
  for (const key of ["filter.norm.clean", "filter.x=y.clean", "filter.x=y.process", "filter.lfs.clean"]) {
    assert.ok(keys.includes(key), key);
  }
});

test("a filter set only in a submodule's config never runs", () => {
  const repo = makeRepo();
  const origin = makeRepo();
  fs.writeFileSync(path.join(origin, ".gitattributes"), "*.js filter=vendor\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "attributes");
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, "vendor");
  git(repo, "commit", "-qm", "submodule");
  const vendor = path.join(repo, "vendor");
  // The filter runs inside the submodule, so the marker lands in the parent.
  git(vendor, "config", "filter.vendor.clean", "echo vendor >> ../filter-ran.txt; cat");
  fs.appendFileSync(path.join(vendor, "app.js"), "// dirty\n");
  fs.appendFileSync(path.join(repo, "app.js"), "// changed\n");
  const marker = path.join(repo, "filter-ran.txt");
  // Control: git diff in the parent inspects the submodule and runs its filter.
  spawnSync("git", ["diff", "--submodule=diff"], { cwd: repo, encoding: "utf8" });
  assert.ok(fs.existsSync(marker));
  fs.rmSync(marker);

  const context = collectReviewContext(repo, { mode: "working-tree", label: "working tree diff" });
  assert.equal(fs.existsSync(marker), false);
  assert.match(context.content, /\/\/ changed/);

  // Also when .gitmodules, which Gemini may edit, asks git to inspect it.
  git(repo, "config", "-f", ".gitmodules", "submodule.vendor.ignore", "none");
  git(repo, "config", "submodule.vendor.ignore", "none");
  spawnSync("git", ["diff", "--submodule=diff"], { cwd: repo, encoding: "utf8" });
  assert.ok(fs.existsSync(marker));
  fs.rmSync(marker);
  collectReviewContext(repo, { mode: "working-tree", label: "working tree diff" });
  assert.equal(fs.existsSync(marker), false);
});

test("a filter passed down by a parent git never runs", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, ".gitattributes"), "app.js filter=param\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "attributes");
  fs.appendFileSync(path.join(repo, "app.js"), "// changed\n");
  const marker = path.join(repo, "filter-ran.txt");
  const parameters = "'filter.param.clean=echo param >> filter-ran.txt; cat'";
  // Control: git applies it.
  spawnSync("git", ["diff"], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_PARAMETERS: parameters } });
  assert.ok(fs.existsSync(marker));
  fs.rmSync(marker);

  const saved = process.env.GIT_CONFIG_PARAMETERS;
  process.env.GIT_CONFIG_PARAMETERS = parameters;
  try {
    const context = collectReviewContext(repo, { mode: "working-tree", label: "working tree diff" });
    assert.match(context.content, /\/\/ changed/);
  } finally {
    if (saved === undefined) {
      delete process.env.GIT_CONFIG_PARAMETERS;
    } else {
      process.env.GIT_CONFIG_PARAMETERS = saved;
    }
  }
  assert.equal(fs.existsSync(marker), false);
});

test("deleted files are still reviewed", () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, "old"));
  fs.writeFileSync(path.join(repo, "old", "gone.js"), "export const GONE = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "old");
  fs.rmSync(path.join(repo, "app.js"));
  fs.rmSync(path.join(repo, "old"), { recursive: true });

  const context = collectReviewContext(repo, { mode: "working-tree", label: "working tree diff" });
  assert.match(context.content, / D app\.js/);
  assert.match(context.content, / D old\/gone\.js/);
  assert.match(context.content, /-export const GONE = 1;/);
  assert.doesNotMatch(context.content, /Links out of the repository/);
  assert.deepEqual(context.changedFiles, ["app.js", "old/gone.js"]);
});

test("unusual file names are listed exactly", () => {
  const repo = makeRepo();
  const name = process.platform === "win32" ? "notes 'quoted' #1.md" : 'notes\t"quoted"\\1.md';
  fs.writeFileSync(path.join(repo, name), "NEW-TEXT\n");
  const context = collectReviewContext(repo, { mode: "working-tree", label: "working tree diff" });
  assert.ok(context.changedFiles.includes(name), JSON.stringify(context.changedFiles));
  assert.match(context.content, /NEW-TEXT/);
  assert.doesNotMatch(context.content, /Links out of the repository/);
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
  assert.deepEqual(policyNames(call.args), ["no-shell.toml", "no-edits.toml", "review.toml"]);
  assert.equal(call.env.noColor, "1");
  assert.match(argAfter(call.args, "--session-id"), /^[0-9a-f-]{36}$/);
  assert.match(call.prompt, /\\@param xs numbers/);
  assert.match(call.prompt, /Transport note/);
  assert.ok(!/(?<!\\)@/.test(call.prompt));
  assert.equal(path.resolve(call.cwd).toLowerCase(), fs.realpathSync.native(repo).toLowerCase());
});

test("an empty review is flagged after a policy refusal, not after an ordinary tool error", () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, "app.js"), "// changed\n");

  const refused = companion(["review"], { cwd: repo, env: makeEnv({ FAKE_GEMINI_MODE: "web-refused" }).env });
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.stdout, /Possibly incomplete:.*\(`web_fetch`\)/);

  const carriedOn = companion(["review"], { cwd: repo, env: makeEnv({ FAKE_GEMINI_MODE: "web-refused-then-read" }).env });
  assert.equal(carriedOn.status, 0, carriedOn.stderr);
  assert.match(carriedOn.stdout, /No material findings/);
  assert.doesNotMatch(carriedOn.stdout, /Possibly incomplete/);

  const failed = companion(["review"], { cwd: repo, env: makeEnv({ FAKE_GEMINI_MODE: "missing-file" }).env });
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.stdout, /No material findings/);
  assert.doesNotMatch(failed.stdout, /Possibly incomplete/);
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
  // Asks may search the web but not open pages.
  assert.deepEqual(policyNames(firstCall.args), ["no-shell.toml", "no-edits.toml", "no-fetch.toml"]);
  assert.equal(argAfter(secondCall.args, "--resume"), argAfter(firstCall.args, "--session-id"));
  assert.match(secondCall.prompt, /<follow_up>\nWhat about NaN inputs\?\n<\/follow_up>/);
});

test("task --write uses auto_edit, keeps the user's policies and reports edited files", () => {
  const repo = makeRepo();
  const { env, capture, geminiHome } = makeEnv();
  const userPolicies = path.join(geminiHome, ".gemini", "policies");
  fs.mkdirSync(userPolicies, { recursive: true });
  const result = companion(["task", "--write", "--model", "pro"], { cwd: repo, env, input: "Fix the empty-list bug." });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Gemini task result \(write mode\)/);
  assert.match(result.stdout, /\*\*Files Gemini edited:\*\*\n- `fixed\.js`/);
  const [call] = captures(capture);
  assert.equal(argAfter(call.args, "--approval-mode"), "auto_edit");
  assert.equal(argAfter(call.args, "--model"), "pro");
  assert.deepEqual(argsAfter(call.args, "--policy").slice(3), [userPolicies]);
  assert.deepEqual(policyNames(call.args).slice(0, 3), ["no-shell.toml", "protected-folders.toml", "no-fetch.toml"]);
  assert.match(call.prompt, /You may create and edit files inside this repository/);
});

test("the Gemini CLI write policy keeps edits out of agent settings and .git", () => {
  const toml = fs.readFileSync(path.join(ROOT, "plugins", "gemini", "policies", "protected-folders.toml"), "utf8");
  // The policies cover every edit tool the companion knows of.
  assert.match(toml, /toolName = \["write_file", "replace", "edit", "edit_file", "smart_edit"\]/);
  const readOnly = fs.readFileSync(path.join(ROOT, "plugins", "gemini", "policies", "no-edits.toml"), "utf8");
  assert.match(readOnly, /toolName = \["write_file", "replace", "edit", "edit_file", "smart_edit"\]/);
  // The Gemini CLI matches argsPattern against the call's arguments as JSON.
  const pattern = new RegExp(/^argsPattern = '(.*)'$/m.exec(toml)[1]);
  const refused = (file) => pattern.test(JSON.stringify({ file_path: file, content: "x" }));
  // Other names a tool may give its path.
  assert.ok(pattern.test(JSON.stringify({ absolute_path: "/repo/.claude/settings.json" })));
  assert.ok(pattern.test(JSON.stringify({ path: "C:\\repo\\.mcp.json" })));
  for (const file of [
    ".claude/settings.local.json",
    "/repo/.mcp.json",
    "C:\\repo\\.Claude\\settings.json",
    ".agents/hooks.json",
    "C:\\repo\\.agents\\mcp.json",
    "/repo/sub/.gemini/settings.json",
    "/repo/.git/hooks/pre-commit",
    "C:\\repo\\vendor\\.GIT\\config",
    ".Gemini/settings.json",
    "/repo/.git",
    // Spellings Windows reads as the same folder.
    "C:\\repo\\.agents.\\hooks.json",
    "C:\\repo\\.gemini \\settings.json",
    "C:\\repo\\.git::$INDEX_ALLOCATION\\config",
    "C:\\repo\\AGENTS~1\\hooks.json",
    "C:\\repo\\GIT~1\\config",
    "C:.git\\hooks\\pre-commit",
    // A quote in a folder name, written as \" in JSON.
    '/repo/a"b/.claude/settings.json',
    '/repo/a"b/.mcp.json'
  ]) {
    assert.ok(refused(file), file);
  }
  // Arguments written as JSON with spaces.
  assert.ok(pattern.test('{"file_path": "/repo/.agents/hooks.json", "content": "x"}'));
  for (const file of [
    "/repo/src/app.js",
    "/repo/.github/workflows/ci.yml",
    "/repo/.gitignore",
    "C:\\repo\\docs\\agents.md",
    "/repo/AGENTS.md",
    "/repo/my.gemini.txt",
    "/repo/.gemini.txt",
    "/repo/.agentsrc",
    "/repo/CLAUDE.md",
    "/repo/docs/claude.md",
    "/repo/mcp.json"
  ]) {
    assert.ok(!refused(file), file);
  }
});

test("auth failures explain how to sign in", () => {
  const repo = makeRepo();
  const { env } = makeEnv({ FAKE_GEMINI_MODE: "auth" });
  const result = companion(["ask"], { cwd: repo, env, input: "hello" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not signed in/);
  assert.match(result.stdout, /Sign in with Google/);
});

test("untrusted folders are explained, and the live check trusts its own scratch folder", () => {
  const repo = makeRepo();
  const { env, capture } = makeEnv({ FAKE_GEMINI_MODE: "untrusted" });
  const asked = companion(["ask"], { cwd: repo, env, input: "hello" });
  assert.equal(asked.status, 1);
  assert.match(asked.stdout, /this folder is not trusted/);
  assert.match(asked.stdout, /Trust folder/);

  const setup = companion(["setup", "--check", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).live.ok, true);

  const [askCall, checkCall] = captures(capture);
  assert.equal(askCall.env.trust, null);
  assert.equal(checkCall.env.trust, "true");
  assert.deepEqual(policyNames(checkCall.args), ["no-shell.toml", "no-edits.toml", "review.toml"]);
});

test("an outdated Gemini CLI is flagged by setup and by failed runs", () => {
  const repo = makeRepo();
  const report = JSON.parse(companion(["setup", "--json"], { cwd: repo, env: makeEnv({ FAKE_GEMINI_VERSION: "0.40.2" }).env }).stdout);
  assert.equal(report.gemini.supported, false);
  assert.equal(report.ready, false);
  assert.match(report.nextSteps.join("\n"), /Update the Gemini CLI to 0\.41\.0 or newer/);

  const result = companion(["ask"], { cwd: repo, env: makeEnv({ FAKE_GEMINI_MODE: "old" }).env, input: "hello" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /needs version 0\.41\.0 or newer/);
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
  assert.equal(report.gemini.version, "0.61.0");
  assert.equal(report.gemini.supported, true);
  assert.equal(typeof report.auth.configured, "boolean");
});

test("a run counts as stopped after a refusal only when it read no more of the repository", () => {
  const repo = path.resolve(os.tmpdir(), "repo");
  const outside = path.resolve(os.tmpdir(), "elsewhere", "settings.json");
  const notes = path.resolve(os.tmpdir(), "profile", "brain", "abc", "task.md");
  const refused = (name, startedAt, endedAt) => ({ name, status: "error", error: "tool call denied by pre-tool hook: not allowed", startedAt, endedAt });
  const ok = (name, startedAt, endedAt, parameters = { AbsolutePath: path.join(repo, "app.js") }) => ({ name, status: "success", startedAt, endedAt, parameters });
  const failed = (name, startedAt, endedAt) => ({ name, status: "error", error: "File not found", startedAt, endedAt });
  const stopped = (...toolCalls) => stoppedAfterRefusal({ toolCalls }, repo);

  assert.equal(stopped(), false);
  assert.equal(stopped(ok("view_file", 1, 2), failed("view_file", 3, 4)), false);
  assert.equal(stopped(ok("view_file", 1, 2), refused("read_url_content", 3, 4)), true);
  assert.equal(stopped(refused("view_file", 1, 2), ok("grep_search", 3, 4, { SearchPath: repo }), ok("finish", 5, 6)), false);
  assert.equal(stopped(refused("view_file", 1, 2), ok("read_file", 3, 4, { file_path: "app.js" })), false);
  // Bookkeeping, notes, failed calls and reads outside the repository are not reviewing.
  assert.equal(stopped(refused("read_url_content", 1, 2), ok("finish", 3, 4), failed("view_file", 5, 6)), true);
  assert.equal(stopped(refused("read_url_content", 1, 2), ok("write_to_file", 3, 4, { TargetFile: notes })), true);
  assert.equal(stopped(refused("read_url_content", 1, 2), ok("view_file", 3, 4, { AbsolutePath: notes })), true);
  assert.equal(stopped(refused("view_file", 1, 2), ok("view_file", 3, 4, { AbsolutePath: outside })), true);
  assert.equal(stopped(refused("view_file", 1, 2), ok("view_file", 3, 4, { AbsolutePath: "~/brain/abc/task.md" })), true);
  assert.equal(stopped(refused("view_file", 1, 2), ok("view_file", 3, 4, { AbsolutePath: pathToFileURL(notes).href })), true);
  assert.equal(stopped(refused("view_file", 1, 2), ok("view_file", 3, 4, { AbsolutePath: pathToFileURL(path.join(repo, "app.js")).href })), false);
  // Listing folders or finding files by name is not reading the change.
  assert.equal(stopped(refused("read_url_content", 1, 2), ok("list_dir", 3, 4, { DirectoryPath: repo }), ok("find_by_name", 5, 6, { SearchDirectory: repo })), true);
  // A read started before the refusal came back does not count, even if listed after it.
  assert.equal(stopped(refused("view_file", 1, 3), ok("view_file", 2, 4)), true);
  // Only the last refusal counts.
  assert.equal(stopped(refused("view_file", 1, 2), ok("view_file", 3, 4), refused("search_web", 5, 6), ok("finish", 7, 8)), true);
  // Records without event counts fall back to their order in the list.
  assert.equal(stoppedAfterRefusal({ toolCalls: [refused("view_file"), ok("view_file")] }, repo), false);
  assert.deepEqual(refusedTools({ toolCalls: [refused("view_file"), refused("view_file"), failed("grep_search")] }), ["view_file"]);
});

test("a read through a link out of the repository does not count as reading it", () => {
  const repo = tempDir("gemini-cc-repo-");
  const notes = tempDir("gemini-cc-notes-");
  fs.writeFileSync(path.join(notes, "task.md"), "blocked\n");
  fs.writeFileSync(path.join(repo, "app.js"), "x\n");
  fs.symlinkSync(notes, path.join(repo, "notes-link"), "junction");
  const refused = { name: "read_url_content", status: "error", error: "tool call denied by pre-tool hook: off", startedAt: 1, endedAt: 2 };
  const read = (file) => ({ name: "view_file", status: "success", startedAt: 3, endedAt: 4, parameters: { AbsolutePath: file } });

  assert.equal(stoppedAfterRefusal({ toolCalls: [refused, read(path.join(repo, "notes-link", "task.md"))] }, repo), true);
  assert.equal(stoppedAfterRefusal({ toolCalls: [refused, read(path.join(repo, "app.js"))] }, repo), false);

  // The repository reached through a link counts as the repository, by either name.
  const alias = path.join(tempDir("gemini-cc-alias-"), "repo");
  fs.symlinkSync(repo, alias, "junction");
  assert.equal(stoppedAfterRefusal({ toolCalls: [refused, read("app.js")] }, alias), false);
  assert.equal(stoppedAfterRefusal({ toolCalls: [refused, read(path.join(repo, "app.js"))] }, alias), false);
  assert.equal(stoppedAfterRefusal({ toolCalls: [refused, read(path.join(alias, "app.js"))] }, repo), false);
  assert.equal(stoppedAfterRefusal({ toolCalls: [refused, read("new-file.js")] }, alias), false);
});
