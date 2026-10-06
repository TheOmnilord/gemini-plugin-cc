// Tests for the PreToolUse guard that the agy backend installs in its profile.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decide } from "../plugins/gemini/scripts/agy-guard.mjs";
import { ROOT, tempDir } from "./helpers.mjs";

const GUARD = path.join(ROOT, "plugins", "gemini", "scripts", "agy-guard.mjs");
const workspace = path.resolve(os.tmpdir(), "guard-workspace");
const profile = path.resolve(os.tmpdir(), "guard-profile");
const cli = path.join(profile, ".gemini", "antigravity-cli");
const conversation = "0f68227d-2171-4b66-93c8-c5dc4cba4d44";
// This conversation's folder; the rest of brain/ belongs to other conversations.
const notes = path.join(cli, "brain", conversation);
const otherNotes = path.join(cli, "brain", "2118e4ac-5b57-4f75-8ad7-f120267e9810");

function env(extra = {}) {
  return { GEMINI_CC_PROFILE: profile, GEMINI_CC_MODE: "read-only", GEMINI_CC_WEB: "0", ...extra };
}

// agy reports workspace paths with forward slashes.
function call(name, args = {}) {
  return { conversationId: conversation, toolCall: { name, args }, workspacePaths: [workspace.split(path.sep).join("/")] };
}

function decision(name, args, extra) {
  return decide(call(name, args), env(extra)).decision;
}

test("reads stay inside the repository and this conversation's notes", () => {
  assert.equal(decision("view_file", { AbsolutePath: path.join(workspace, "src", "app.js") }), "allow");
  assert.equal(decision("list_dir", { DirectoryPath: workspace }), "allow");
  assert.equal(decision("grep_search", { Query: "../secret", SearchPath: workspace }), "allow");
  assert.equal(decision("find_by_name", { Pattern: "*.js", SearchDirectory: "src" }), "allow");
  assert.equal(decision("view_file", { AbsolutePath: path.join(notes, ".system_generated", "steps", "4", "content.md") }), "allow");
  // Other conversations, possibly from other repositories, stay closed.
  assert.equal(decision("view_file", { AbsolutePath: path.join(otherNotes, ".system_generated", "logs", "transcript.jsonl") }), "deny");
  assert.equal(decision("list_dir", { DirectoryPath: path.join(cli, "brain") }), "deny");
  assert.equal(decision("view_file", { AbsolutePath: path.join(cli, "conversation_summaries.db") }), "deny");
  assert.equal(decision("grep_search", { Query: "secret", SearchPath: path.join(cli, "conversations") }), "deny");
  assert.equal(decide({ ...call("view_file", { AbsolutePath: path.join(notes, "a.md") }), conversationId: "../.." }, env()).decision, "deny");
  // A read that names no path cannot be checked.
  assert.equal(decision("grep_search", { Query: "secret" }), "deny");
  assert.equal(decision("view_file", { AbsolutePath: path.join(workspace, "..", "secret.txt") }), "deny");
  assert.equal(decision("view_file", { AbsolutePath: "../secret.txt" }), "deny");
  assert.equal(decision("view_file", { AbsolutePath: "~/.ssh/id_rsa" }), "deny");
  assert.equal(decision("grep_search", { Query: "token", SearchPath: path.parse(workspace).root }), "deny");
  assert.equal(decision("list_dir", { DirectoryPath: `${workspace}-sibling` }), "deny");
});

test("read-only runs cannot edit, write runs edit only inside the repository", () => {
  const inside = { TargetFile: path.join(workspace, "app.js") };
  assert.equal(decision("write_to_file", inside), "deny");
  assert.equal(decision("replace_file_content", inside), "deny");
  assert.equal(decision("write_to_file", inside, { GEMINI_CC_MODE: "write" }), "allow");
  assert.equal(decision("multi_replace_file_content", inside, { GEMINI_CC_MODE: "write" }), "allow");
  assert.equal(decision("write_to_file", { TargetFile: path.join(workspace, "..", "x.txt") }, { GEMINI_CC_MODE: "write" }), "deny");
  assert.equal(decision("write_to_file", { TargetFile: path.join(workspace, ".git", "config") }, { GEMINI_CC_MODE: "write" }), "deny");
  assert.equal(decision("write_to_file", {}, { GEMINI_CC_MODE: "write" }), "deny");
  // agy keeps its own plans and notes in the profile, in any mode.
  assert.equal(decision("write_to_file", { TargetFile: path.join(notes, "task.md") }), "allow");
  assert.equal(decision("write_to_file", { TargetFile: path.join(otherNotes, "task.md") }), "deny");
  assert.equal(decision("write_to_file", { TargetFile: path.join(profile, ".gemini", "antigravity-cli", "settings.json") }), "deny");
});

test("edits stay out of every .git, also in nested repositories", () => {
  const write = (file) => decision("write_to_file", { TargetFile: path.join(workspace, ...file.split("/")) }, { GEMINI_CC_MODE: "write" });
  // Case is ignored everywhere: Windows and macOS read .GIT as .git.
  for (const file of ["packages/vendored/.git/hooks/post-checkout", "sub/.git", "a/b/c/.git/config", "sub/.GIT/hooks/pre-commit", ".Git/config"]) {
    assert.equal(write(file), "deny", file);
  }
  // Windows also reads these as .git, and alternate data streams are refused.
  if (process.platform === "win32") {
    for (const file of ["sub/.git./hooks/pre-commit", "sub/.git /config", "sub/.git::$INDEX_ALLOCATION/config", "GIT~1:probe", "src/notes.txt:hidden"]) {
      assert.equal(write(file), "deny", file);
    }
    const extended = `\\\\?\\${path.join(workspace, "src", "app.js")}`;
    assert.equal(decision("write_to_file", { TargetFile: extended }, { GEMINI_CC_MODE: "write" }), "allow");
  }
  // Names that only look alike are fine.
  for (const file of [".github/workflows/ci.yml", "docs/my.git.md", ".gitignore", "src/.gitkeep"]) {
    assert.equal(write(file), "allow", file);
  }
});

test("shell, browser and unknown tools are always denied; bookkeeping is allowed", () => {
  for (const name of ["run_command", "send_command_input", "notebook_execution", "open_browser_url", "call_mcp_tool", "schedule", "brand_new_tool"]) {
    assert.equal(decision(name, {}, { GEMINI_CC_MODE: "write", GEMINI_CC_WEB: "1" }), "deny", name);
  }
  assert.equal(decision("finish", { verdict: "approve" }), "allow");
  assert.equal(decision("wait", {}), "allow");
});

test("web search follows the run's web setting", () => {
  assert.equal(decision("search_web", { query: "agy" }), "deny");
  // The reason tells Gemini to carry on, not to stop and ask for access.
  assert.match(decide(call("search_web", { query: "agy" }), env()).reason, /cannot be switched on[\s\S]*carry on/);
  assert.equal(decision("search_web", { query: "agy" }, { GEMINI_CC_WEB: "1" }), "allow");
});

test("pages open only when the run lists their exact address", () => {
  const allow = JSON.stringify(["https://docs.example.com/spec?v=2", "http://127.0.0.1:3000/"]);
  // Web search on does not open pages.
  assert.equal(decision("read_url_content", { Url: "https://example.com" }, { GEMINI_CC_WEB: "1" }), "deny");
  assert.match(decide(call("read_url_content", { Url: "https://example.com" }), env()).reason, /cannot be switched on[\s\S]*carry on/);

  assert.equal(decision("read_url_content", { Url: "https://docs.example.com/spec?v=2" }, { GEMINI_CC_WEB_ALLOW: allow }), "allow");
  assert.equal(decision("read_url_content", { Url: "https://docs.example.com/spec?v=2#limits" }, { GEMINI_CC_WEB_ALLOW: allow }), "allow");
  assert.equal(decision("read_url_content", { Url: "http://127.0.0.1:3000" }, { GEMINI_CC_WEB_ALLOW: allow }), "allow");
  // One trailing slash more or less is accepted; nothing else is.
  const paths = JSON.stringify(["https://docs.example.com/api/spec", "https://docs.example.com/guide/"]);
  assert.equal(decision("read_url_content", { Url: "https://docs.example.com/api/spec/" }, { GEMINI_CC_WEB_ALLOW: paths }), "allow");
  assert.equal(decision("read_url_content", { Url: "https://docs.example.com/guide" }, { GEMINI_CC_WEB_ALLOW: paths }), "allow");
  for (const url of [
    "https://docs.example.com/api/spec//",
    "https://docs.example.com/api/spec/x",
    "https://docs.example.com/guide//",
    "https://docs.example.com/guide///"
  ]) {
    assert.equal(decision("read_url_content", { Url: url }, { GEMINI_CC_WEB_ALLOW: paths }), "deny", url);
  }
  // No slash tolerance next to a query, or when the listed address itself ends in "//".
  const odd = JSON.stringify(["https://docs.example.com/a//", "https://docs.example.com/q?v=2", "https://docs.example.com/r/?v=2"]);
  for (const url of ["https://docs.example.com/a/", "https://docs.example.com/q?v=2/", "https://docs.example.com/r?v=2"]) {
    assert.equal(decision("read_url_content", { Url: url }, { GEMINI_CC_WEB_ALLOW: odd }), "deny", url);
  }
  for (const url of [
    "https://docs.example.com/spec?v=2&leak=secret",
    "https://docs.example.com/spec",
    "https://docs.example.com/other",
    "https://evil.test/https://docs.example.com/spec?v=2",
    "http://127.0.0.1:3001/",
    "http://127.0.0.1:3000//",
    "file:///etc/passwd",
    // Each of these normalizes to a listed page, but agy would send the path as written.
    "https://docs.example.com/SECRET/../spec?v=2",
    "https://docs.example.com/SECRET/%2e%2e/spec?v=2",
    "https://DOCS.example.com/spec?v=2",
    "https://docs.example.com:443/spec?v=2",
    " https://docs.example.com/spec?v=2",
    "docs.example.com/spec?v=2"
  ]) {
    assert.equal(decision("read_url_content", { Url: url }, { GEMINI_CC_WEB_ALLOW: allow }), "deny", url);
  }
  assert.match(decide(call("read_url_content", { Url: "https://x.test/" }), env({ GEMINI_CC_WEB_ALLOW: allow })).reason, /Only these addresses[\s\S]*spec\?v=2/);
  // The address must be in Url, and any other address in the call must be listed too.
  assert.equal(decision("read_url_content", { Url: "https://docs.example.com/spec?v=2", Extra: "https://evil.test/" }, { GEMINI_CC_WEB_ALLOW: allow }), "deny");
  assert.equal(decision("read_url_content", { Url: "evil.test/leak", Extra: "https://docs.example.com/spec?v=2" }, { GEMINI_CC_WEB_ALLOW: allow }), "deny");
  assert.equal(decision("read_url_content", { url: "https://docs.example.com/spec?v=2" }, { GEMINI_CC_WEB_ALLOW: allow }), "deny");
  assert.equal(decision("read_url_content", {}, { GEMINI_CC_WEB_ALLOW: allow }), "deny");
  assert.equal(
    decision("read_url_content", { Url: "https://docs.example.com/spec?v=2", toolAction: "Reading the spec", toolSummary: "Read spec" }, { GEMINI_CC_WEB_ALLOW: allow }),
    "allow"
  );
  assert.equal(decision("search_web", { query: "agy" }, { GEMINI_CC_WEB_ALLOW: allow }), "deny");
  assert.equal(decision("read_url_content", { Url: "https://a.test/" }, { GEMINI_CC_WEB_ALLOW: "not json" }), "deny");
});

test("links out of the repository are followed to where they lead", () => {
  const root = tempDir("guard-links-");
  const repo = path.join(root, "repo");
  const outside = path.join(root, "outside");
  fs.mkdirSync(repo);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "x");
  fs.writeFileSync(path.join(repo, "app.js"), "x");
  // A junction needs no special rights on Windows; elsewhere it is a symlink.
  fs.symlinkSync(outside, path.join(repo, "linked"), "junction");
  const check = (name, args, extra) =>
    decide({ conversationId: conversation, toolCall: { name, args }, workspacePaths: [repo] }, env(extra)).decision;

  assert.equal(check("view_file", { AbsolutePath: path.join(repo, "app.js") }), "allow");
  assert.equal(check("view_file", { AbsolutePath: path.join(repo, "linked", "secret.txt") }), "deny");
  assert.equal(check("list_dir", { DirectoryPath: path.join(repo, "linked") }), "deny");
  assert.equal(check("write_to_file", { TargetFile: path.join(repo, "linked", "new.txt") }, { GEMINI_CC_MODE: "write" }), "deny");
  assert.equal(check("write_to_file", { TargetFile: path.join(repo, "new", "deep", "file.txt") }, { GEMINI_CC_MODE: "write" }), "allow");

  // A link to a nested repository's .git is followed to where it leads.
  fs.mkdirSync(path.join(repo, "vendored", ".git", "hooks"), { recursive: true });
  fs.symlinkSync(path.join(repo, "vendored", ".git", "hooks"), path.join(repo, "hooks-link"), "junction");
  assert.equal(check("write_to_file", { TargetFile: path.join(repo, "hooks-link", "post-checkout") }, { GEMINI_CC_MODE: "write" }), "deny");

  // A link whose target does not exist yet: writing through it would create the target outside.
  fs.symlinkSync(path.join(outside, "missing-dir"), path.join(repo, "dangling"), "junction");
  assert.equal(check("write_to_file", { TargetFile: path.join(repo, "dangling", "new.txt") }, { GEMINI_CC_MODE: "write" }), "deny");
  assert.equal(check("view_file", { AbsolutePath: path.join(repo, "dangling") }), "deny");
});

test("paths compare without case on Windows", { skip: process.platform !== "win32" }, () => {
  assert.equal(decision("view_file", { AbsolutePath: path.join(workspace.toUpperCase(), "app.js") }), "allow");
});

test("the hook script reads a call on stdin and prints its decision", () => {
  const run = (input, extra = {}) =>
    JSON.parse(spawnSync(process.execPath, [GUARD], { input, encoding: "utf8", env: { ...process.env, ...env(extra) } }).stdout);
  assert.deepEqual(run(JSON.stringify(call("view_file", { AbsolutePath: path.join(workspace, "a.js") }))), { decision: "allow" });
  assert.equal(run(JSON.stringify(call("write_to_file", { TargetFile: path.join(workspace, "a.js") }))).decision, "deny");
  assert.equal(run("not json").decision, "deny");
});

test("the hook logs each decision with its call when asked to", () => {
  const logFile = path.join(tempDir("guard-log-"), "guard.jsonl");
  const run = (payload) =>
    spawnSync(process.execPath, [GUARD], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...env({ GEMINI_CC_GUARD_LOG: logFile }) } });
  const target = path.join(workspace, "a.js");
  run({ ...call("write_to_file", { TargetFile: target, CodeContent: "x".repeat(2000) }), conversationId: "0123abcd-ef" });
  run(call("view_file", { AbsolutePath: target }));
  const [write, read] = fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(write.tool, "write_to_file");
  assert.equal(write.decision, "deny");
  assert.equal(write.conversation, "0123abcd-ef");
  assert.equal(write.profile, profile);
  assert.equal(write.args.TargetFile, target);
  assert.equal(write.args.CodeContent.length, 500);
  assert.equal(read.decision, "allow");
  assert.equal(read.args.AbsolutePath, target);
});
