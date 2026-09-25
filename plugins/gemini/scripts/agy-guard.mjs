#!/usr/bin/env node
// PreToolUse hook for the plugin's private Antigravity CLI (agy) profile.
//
// agy runs it before every tool call, with the call on stdin, and follows the
// decision it prints. The companion sets GEMINI_CC_MODE (read-only or write)
// and GEMINI_CC_WEB for each run, so one profile serves every kind of run and
// conversations can be resumed across them.
//
// Headless agy approves file writes anywhere on disk by default, so this hook
// is what keeps a run read-only, or its edits inside the repository. Anything
// it does not recognize is denied.
//
// The companion copies this file next to the profile's hooks.json, so it must
// stay self-contained: Node built-ins only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const READ_TOOLS = new Set(["view_file", "list_dir", "grep_search", "find_by_name"]);
const WRITE_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"]);
const WEB_TOOLS = new Set(["search_web", "read_url_content"]);
// Bookkeeping with no effect outside the conversation. finish returns --json-schema output.
const NEUTRAL_TOOLS = new Set(["finish", "wait", "wait_5_seconds", "list_permissions", "command_status"]);
const PATH_KEY = /(path|paths|file|files|directory|directories|dir|dirs|cwd)$/i;
const IS_WINDOWS = process.platform === "win32";

function allow() {
  return { decision: "allow" };
}

function deny(reason) {
  return { decision: "deny", reason };
}

function comparable(file) {
  const resolved = path.resolve(file);
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

function isInside(file, root) {
  const relative = path.relative(comparable(root), comparable(file));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function insideAny(file, roots) {
  return roots.some((root) => root && isInside(file, root));
}

// Path-like arguments (TargetFile, AbsolutePath, SearchDirectory, ...), resolved
// the way agy resolves them: relative to the workspace, with ~ as the home folder.
function pathArguments(args, baseDir) {
  const found = [];
  const visit = (key, value) => {
    if (typeof value === "string") {
      if (PATH_KEY.test(key) && value.trim()) {
        let file = value.trim();
        if (/^file:\/\//i.test(file)) {
          file = fileURLToPath(file);
        } else if (/^~(?=$|[\\/])/.test(file)) {
          file = path.join(os.homedir(), file.slice(1));
        }
        found.push(path.resolve(baseDir, file));
      }
    } else if (Array.isArray(value)) {
      value.forEach((item) => visit(key, item));
    } else if (value && typeof value === "object") {
      Object.entries(value).forEach(([innerKey, innerValue]) => visit(innerKey, innerValue));
    }
  };
  Object.entries(args && typeof args === "object" ? args : {}).forEach(([key, value]) => visit(key, value));
  return found;
}

function stringValues(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => stringValues(item, out));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => stringValues(item, out));
  }
  return out;
}

export function decide(payload, env = process.env) {
  const tool = String(payload?.toolCall?.name ?? "");
  const args = payload?.toolCall?.args ?? {};
  const writeMode = env.GEMINI_CC_MODE === "write";
  const workspaces = (Array.isArray(payload?.workspacePaths) ? payload.workspacePaths : []).filter(
    (entry) => typeof entry === "string" && entry.trim()
  );
  // agy keeps its own notes (plans, walkthroughs) under brain/ in the profile.
  const profileDir = env.GEMINI_CC_PROFILE ? path.join(env.GEMINI_CC_PROFILE, ".gemini", "antigravity-cli") : null;
  const notesDir = profileDir ? path.join(profileDir, "brain") : null;
  const baseDir = workspaces[0] ?? profileDir ?? os.homedir();

  if (NEUTRAL_TOOLS.has(tool)) {
    return allow();
  }

  if (READ_TOOLS.has(tool)) {
    const outside = pathArguments(args, baseDir).find((file) => !insideAny(file, [...workspaces, profileDir]));
    return outside ? deny(`${tool} may only read inside the repository. Not allowed: ${outside}`) : allow();
  }

  if (WRITE_TOOLS.has(tool)) {
    const targets = pathArguments(args, baseDir);
    if (targets.length && targets.every((file) => insideAny(file, [notesDir]))) {
      return allow();
    }
    if (!writeMode) {
      return deny("This Gemini run from Claude Code is read-only. Describe the change (file, location, new code) instead of making it.");
    }
    if (!targets.length) {
      return deny(`${tool} did not name its target file, so the edit cannot be checked.`);
    }
    const outside = targets.find(
      (file) => !insideAny(file, workspaces) || workspaces.some((root) => isInside(file, path.join(root, ".git")))
    );
    return outside ? deny(`Edits must stay inside the repository and outside .git. Not allowed: ${outside}`) : allow();
  }

  if (WEB_TOOLS.has(tool)) {
    if (env.GEMINI_CC_WEB !== "1") {
      return deny("Web access is switched off for this Gemini run from Claude Code. Ground the answer in the repository.");
    }
    const localUrl = stringValues(args).find((value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value));
    return localUrl ? deny(`Only http and https addresses are allowed: ${localUrl}`) : allow();
  }

  return deny(`${tool || "This tool"} is not available to Gemini runs from Claude Code.`);
}

function logDecision(tool, result) {
  const logFile = process.env.GEMINI_CC_GUARD_LOG;
  if (!logFile) {
    return;
  }
  try {
    fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), tool, ...result })}\n`);
  } catch {
    // Logging is best effort.
  }
}

function main() {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    let result;
    let tool = null;
    try {
      const payload = JSON.parse(input);
      tool = payload?.toolCall?.name ?? null;
      result = decide(payload);
    } catch (error) {
      result = deny(`The Claude Code guard could not read this tool call (${error.message}).`);
    }
    logDecision(tool, result);
    process.stdout.write(JSON.stringify(result));
  });
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedAs && comparable(invokedAs) === comparable(fileURLToPath(import.meta.url))) {
  main();
}
