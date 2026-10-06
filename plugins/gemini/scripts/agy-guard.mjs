#!/usr/bin/env node
// PreToolUse hook for the plugin's private Antigravity CLI (agy) profile.
//
// agy runs it before every tool call, with the call on stdin, and follows the
// decision it prints. The companion sets GEMINI_CC_MODE (read-only or write),
// GEMINI_CC_WEB (web search) and GEMINI_CC_WEB_ALLOW (the addresses Gemini may
// open) for each run, so one profile serves every kind of run and
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

// Where a path really leads, through symlinks and junctions, so a link inside
// the repository cannot carry a read or an edit outside it. A path that does
// not exist yet is resolved through its nearest existing parent. null when
// that fails, which callers treat as outside every root, and for a link whose
// target is missing: a write through it would create the target, wherever it is.
function realLocation(file) {
  let current = path.resolve(file);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest);
    } catch (error) {
      const parent = path.dirname(current);
      if ((error.code !== "ENOENT" && error.code !== "ENOTDIR") || parent === current || isEntry(current)) {
        return null;
      }
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

// True for anything that exists as a directory entry, including a dangling link.
function isEntry(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function isInside(file, root) {
  const relative = path.relative(comparable(root), comparable(file));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Both sides are compared by their real locations.
function insideAny(file, roots) {
  const real = realLocation(file);
  return Boolean(real) && roots.some((root) => {
    const realRoot = root && realLocation(root);
    return Boolean(realRoot) && isInside(real, realRoot);
  });
}

// A path segment as the file system may read it. Case is ignored everywhere,
// as on Windows and macOS (no real repository has a ".GIT"); Windows also
// drops trailing dots and spaces and reads "name:stream" as a stream of name.
function segmentName(part) {
  const name = part.toLowerCase();
  return IS_WINDOWS ? name.split(":")[0].replace(/[. ]+$/, "") : name;
}

// A Windows alternate data stream ("file:stream"). Its base name can be a
// short name such as GIT~1 that cannot be resolved while the stream does not
// exist, and no repository edit needs one, so edits to streams are refused.
function namesStream(file) {
  if (!IS_WINDOWS) {
    return false;
  }
  const resolved = path.resolve(file).replace(/^\\\\\?\\/, "");
  return resolved.slice(path.parse(resolved).root.length).includes(":");
}

// True when a path is inside any .git, at any depth: a nested repository's
// hooks would run the next time git is used there. Checked on the path as
// written and on where it really leads.
function inGitMetadata(file, roots) {
  const real = realLocation(file);
  return roots.some((root) => {
    const realRoot = realLocation(root);
    return [
      [path.resolve(file), path.resolve(root)],
      [real, realRoot]
    ].some(
      ([target, base]) =>
        target &&
        base &&
        isInside(target, base) &&
        path
          .relative(comparable(base), comparable(target))
          .split(path.sep)
          .some((part) => segmentName(part) === ".git")
    );
  });
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

// A page may be opened only as the companion listed it (canonical, without a
// #fragment). The address is compared as written, because agy sends it as
// written: "/x/../spec" or "%2e%2e" would normalize to a listed page while the
// request still carries the extra path. One trailing "/" more or less is
// accepted ("/spec/" for a listed "/spec", "http://host:3000" for a listed
// "http://host:3000/"): a fixed character that cannot carry any data.
function listedExactly(value, allowed) {
  if (typeof value !== "string") {
    return false;
  }
  const bare = value.split("#")[0];
  if (allowed.includes(bare)) {
    return true;
  }
  // A slash more or less at the end of a path, but only between addresses
  // with no query (where a slash would change a value) and no "//" (which
  // some servers route to a different resource).
  const plain = (url) => !url.includes("?") && !url.endsWith("//");
  return plain(bare) && allowed.some((url) => plain(url) && (url === `${bare}/` || `${url}/` === bare));
}

function allowedUrls(env) {
  try {
    const list = JSON.parse(env.GEMINI_CC_WEB_ALLOW || "[]");
    return Array.isArray(list) ? list.filter((url) => typeof url === "string" && /^https?:\/\//i.test(url)) : [];
  } catch {
    return [];
  }
}

export function decide(payload, env = process.env) {
  const tool = String(payload?.toolCall?.name ?? "");
  const args = payload?.toolCall?.args ?? {};
  const writeMode = env.GEMINI_CC_MODE === "write";
  const workspaces = (Array.isArray(payload?.workspacePaths) ? payload.workspacePaths : []).filter(
    (entry) => typeof entry === "string" && entry.trim()
  );
  // agy keeps each conversation's notes, and its copies of fetched pages, in
  // brain/<conversation id> in the profile. Only this conversation's folder
  // is open: the others hold transcripts from other repositories.
  const profileDir = env.GEMINI_CC_PROFILE ? path.join(env.GEMINI_CC_PROFILE, ".gemini", "antigravity-cli") : null;
  const conversationId = String(payload?.conversationId ?? "");
  const notesDir = profileDir && /^[0-9a-f-]{8,64}$/i.test(conversationId) ? path.join(profileDir, "brain", conversationId) : null;
  const baseDir = workspaces[0] ?? notesDir ?? os.homedir();

  if (NEUTRAL_TOOLS.has(tool)) {
    return allow();
  }

  if (READ_TOOLS.has(tool)) {
    const targets = pathArguments(args, baseDir);
    if (!targets.length) {
      return deny(`${tool} did not name a path, so the read cannot be checked. Name the file or folder in the repository.`);
    }
    const outside = targets.find((file) => !insideAny(file, [...workspaces, notesDir]));
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
    const outside = targets.find((file) => !insideAny(file, workspaces) || inGitMetadata(file, workspaces) || namesStream(file));
    return outside ? deny(`Edits must stay inside the repository and outside .git. Not allowed: ${outside}`) : allow();
  }

  // Opening a URL is allowed only for the exact addresses the user or Claude
  // listed for this run (--allow-url); web search follows the run's web setting.
  if (tool === "read_url_content") {
    const allowed = allowedUrls(env);
    // agy reads the address from Url. Any other address-like value must be
    // listed too, in case a later agy reads it from elsewhere.
    const others = stringValues({ ...args, Url: undefined }).filter((value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()));
    if (allowed.length && listedExactly(args.Url, allowed) && others.every((value) => listedExactly(value, allowed))) {
      return allow();
    }
    return deny(
      allowed.length
        ? `Only these addresses may be opened in this Gemini run from Claude Code: ${allowed.join(", ")}. Do not ask for others: carry on with the request using them and the repository.`
        : "Opening web pages is off for this Gemini run from Claude Code and cannot be switched on from inside it. Do not ask for it: carry on with the request using the repository."
    );
  }

  if (WEB_TOOLS.has(tool)) {
    if (env.GEMINI_CC_WEB !== "1") {
      return deny(
        "Web access is off for this Gemini run from Claude Code and cannot be switched on from inside it. Do not ask for it: carry on with the request using the repository alone."
      );
    }
    return allow();
  }

  return deny(`${tool || "This tool"} is not available to Gemini runs from Claude Code.`);
}

// A debugging aid (and the evidence for npm run live-check): each decision
// with the call it was made for. Long values such as file contents are cut.
function logDecision(payload, result) {
  const logFile = process.env.GEMINI_CC_GUARD_LOG;
  if (!logFile) {
    return;
  }
  const short = (value) =>
    typeof value === "string"
      ? value.slice(0, 500)
      : Array.isArray(value)
        ? value.map(short)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, short(item)]))
          : value;
  try {
    const entry = {
      at: new Date().toISOString(),
      conversation: payload?.conversationId ?? null,
      profile: process.env.GEMINI_CC_PROFILE ?? null,
      tool: payload?.toolCall?.name ?? null,
      args: short(payload?.toolCall?.args ?? null),
      ...result
    };
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
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
    let payload = null;
    try {
      payload = JSON.parse(input);
      result = decide(payload);
    } catch (error) {
      result = deny(`The Claude Code guard could not read this tool call (${error.message}).`);
    }
    logDecision(payload, result);
    process.stdout.write(JSON.stringify(result));
  });
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedAs && comparable(invokedAs) === comparable(fileURLToPath(import.meta.url))) {
  main();
}
