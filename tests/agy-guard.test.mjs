// Tests for the PreToolUse guard that the agy backend installs in its profile.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decide } from "../plugins/gemini/scripts/agy-guard.mjs";
import { ROOT } from "./helpers.mjs";

const GUARD = path.join(ROOT, "plugins", "gemini", "scripts", "agy-guard.mjs");
const workspace = path.resolve(os.tmpdir(), "guard-workspace");
const profile = path.resolve(os.tmpdir(), "guard-profile");
const brain = path.join(profile, ".gemini", "antigravity-cli", "brain");

function env(extra = {}) {
  return { GEMINI_CC_PROFILE: profile, GEMINI_CC_MODE: "read-only", GEMINI_CC_WEB: "0", ...extra };
}

// agy reports workspace paths with forward slashes.
function call(name, args = {}) {
  return { toolCall: { name, args }, workspacePaths: [workspace.split(path.sep).join("/")] };
}

function decision(name, args, extra) {
  return decide(call(name, args), env(extra)).decision;
}

test("reads stay inside the repository and the plugin's profile", () => {
  assert.equal(decision("view_file", { AbsolutePath: path.join(workspace, "src", "app.js") }), "allow");
  assert.equal(decision("list_dir", { DirectoryPath: workspace }), "allow");
  assert.equal(decision("grep_search", { Query: "../secret", SearchPath: workspace }), "allow");
  assert.equal(decision("find_by_name", { Pattern: "*.js", SearchDirectory: "src" }), "allow");
  assert.equal(decision("view_file", { AbsolutePath: path.join(brain, "x", "plan.md") }), "allow");
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
  assert.equal(decision("write_to_file", { TargetFile: path.join(brain, "id", "task.md") }), "allow");
  assert.equal(decision("write_to_file", { TargetFile: path.join(profile, ".gemini", "antigravity-cli", "settings.json") }), "deny");
});

test("shell, browser and unknown tools are always denied; bookkeeping is allowed", () => {
  for (const name of ["run_command", "send_command_input", "notebook_execution", "open_browser_url", "call_mcp_tool", "schedule", "brand_new_tool"]) {
    assert.equal(decision(name, {}, { GEMINI_CC_MODE: "write", GEMINI_CC_WEB: "1" }), "deny", name);
  }
  assert.equal(decision("finish", { verdict: "approve" }), "allow");
  assert.equal(decision("wait", {}), "allow");
});

test("web tools follow the run's web setting and only reach http(s)", () => {
  assert.equal(decision("search_web", { query: "agy" }), "deny");
  // The reason tells Gemini to carry on, not to stop and ask for access.
  assert.match(decide(call("read_url_content", { Url: "https://example.com" }), env()).reason, /cannot be switched on[\s\S]*carry on/);
  assert.equal(decision("search_web", { query: "agy" }, { GEMINI_CC_WEB: "1" }), "allow");
  assert.equal(decision("read_url_content", { Url: "https://example.com" }, { GEMINI_CC_WEB: "1" }), "allow");
  assert.equal(decision("read_url_content", { Url: "file:///etc/passwd" }, { GEMINI_CC_WEB: "1" }), "deny");
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
