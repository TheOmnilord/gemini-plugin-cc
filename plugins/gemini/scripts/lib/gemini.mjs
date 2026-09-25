// Launches the Gemini CLI in headless mode and reads its stream-json output.
//
// The prompt goes in on stdin (the CLI appends the --prompt text after it), so
// there is no command-line length limit and no shell quoting involved.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { killProcessTree, runCommand, runShellLine } from "./proc.mjs";

export const GEMINI_PACKAGE = "@google/gemini-cli";
export const INSTALL_COMMAND = "npm install -g @google/gemini-cli";
const AUTH_EXIT_CODE = 41;
const TURN_LIMIT_EXIT_CODE = 53;
const INPUT_ERROR_EXIT_CODE = 42;
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]+$/;
const WRITE_TOOLS = new Set(["write_file", "replace", "edit", "edit_file", "smart_edit"]);

export class GeminiUnavailableError extends Error {
  constructor() {
    super(`The Gemini CLI was not found. Install it with \`${INSTALL_COMMAND}\` (Node.js 20+), then run /gemini:setup.`);
    this.name = "GeminiUnavailableError";
  }
}

// The Gemini CLI turns "@path" in a prompt into a file lookup (with a fuzzy
// recursive search), so every at-sign is escaped before the prompt is sent.
export function escapeAtSigns(text) {
  return text.replace(/@/g, "\\@");
}

export function restoreAtSigns(text) {
  return String(text ?? "").replace(/\\@/g, "@");
}

export function geminiHomeDir() {
  const override = process.env.GEMINI_CLI_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".gemini");
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function readPackage(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (pkg.name !== GEMINI_PACKAGE) {
      return null;
    }
    const relative = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.gemini;
    const entry = relative ? path.resolve(dir, relative) : null;
    return entry && isFile(entry) ? { dir: path.resolve(dir), entry, version: pkg.version ?? null } : null;
  } catch {
    return null;
  }
}

// npm puts a shim next to node_modules on Windows (<prefix>\gemini.cmd) and a
// symlink into <prefix>/lib/node_modules on macOS and Linux.
function findPackageForShim(shim) {
  const dirs = [path.dirname(shim)];
  try {
    dirs.push(path.dirname(fs.realpathSync(shim)));
  } catch {
    // Broken symlink: only the shim's own directory is left to try.
  }
  for (const dir of dirs) {
    for (const candidate of [
      path.join(dir, "node_modules", "@google", "gemini-cli"),
      path.join(dir, "..", "lib", "node_modules", "@google", "gemini-cli"),
      path.join(dir, "..")
    ]) {
      const pkg = readPackage(candidate);
      if (pkg) {
        return pkg;
      }
    }
  }
  return null;
}

export function resolveGeminiLaunch() {
  const override = process.env.GEMINI_COMPANION_CLI?.trim();
  if (override) {
    if (/\.(c|m)?js$/i.test(override)) {
      return { command: process.execPath, prefixArgs: [path.resolve(override)], useShell: false, source: override, version: null };
    }
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(override);
    return { command: override, prefixArgs: [], useShell, source: override, version: null };
  }

  const names = process.platform === "win32" ? ["gemini.cmd", "gemini.exe", "gemini"] : ["gemini"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (!isFile(candidate)) {
        continue;
      }
      const pkg = findPackageForShim(candidate);
      if (pkg) {
        // Run the CLI's own entry point with this Node binary: no shim, no shell.
        return { command: process.execPath, prefixArgs: [pkg.entry], useShell: false, source: candidate, version: pkg.version };
      }
      if (process.platform !== "win32" || /\.exe$/i.test(name)) {
        return { command: candidate, prefixArgs: [], useShell: false, source: candidate, version: null };
      }
      if (/\.cmd$/i.test(name)) {
        return { command: candidate, prefixArgs: [], useShell: true, source: candidate, version: null };
      }
    }
  }
  return null;
}

function quoteForCmd(value) {
  return /^[A-Za-z0-9_.:\\/=,+-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
}

function buildShellLine(launch, args) {
  return [launch.command, ...launch.prefixArgs, ...args].map(quoteForCmd).join(" ");
}

export function getGeminiVersion(launch) {
  if (launch.version) {
    return launch.version;
  }
  const result = launch.useShell
    ? runShellLine(buildShellLine(launch, ["--version"]), { timeout: 30000 })
    : runCommand(launch.command, [...launch.prefixArgs, "--version"], { timeout: 30000 });
  const output = `${result.stdout ?? ""}`.trim().split(/\r?\n/).pop();
  return result.status === 0 && output ? output : null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Only key names are read from .env files; values never leave the file.
function readDotenvKeys(file) {
  const keys = new Set();
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return keys;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match && match[2].replace(/^["']|["']$/g, "").trim()) {
      keys.add(match[1]);
    }
  }
  return keys;
}

export function getAuthStatus() {
  const home = geminiHomeDir();
  const settings = readJson(path.join(home, "settings.json"));
  const selectedType = settings?.security?.auth?.selectedType ?? settings?.selectedAuthType ?? null;
  const dotenvKeys = readDotenvKeys(path.join(home, ".env"));
  const has = (name) => Boolean(process.env[name]?.trim()) || dotenvKeys.has(name);
  const truthy = (name) => /^(1|true|yes)$/i.test(process.env[name]?.trim() ?? "") || dotenvKeys.has(name);

  let method = selectedType;
  if (!method && has("GEMINI_API_KEY")) {
    method = "gemini-api-key";
  } else if (!method && truthy("GOOGLE_GENAI_USE_VERTEXAI")) {
    method = "vertex-ai";
  } else if (!method && truthy("GOOGLE_GENAI_USE_GCA")) {
    method = "oauth-personal";
  }

  const notes = [];
  if (method === "gemini-api-key" && !has("GEMINI_API_KEY")) {
    notes.push("API-key sign-in is selected, but GEMINI_API_KEY is not set in the environment or in ~/.gemini/.env.");
  }
  return {
    configured: Boolean(method),
    method,
    googleCloudProjectSet: has("GOOGLE_CLOUD_PROJECT") || has("GOOGLE_CLOUD_PROJECT_ID"),
    settingsFile: path.join(home, "settings.json"),
    notes
  };
}

function summarizeParams(parameters) {
  if (!parameters || typeof parameters !== "object") {
    return "";
  }
  const value =
    parameters.file_path ?? parameters.absolute_path ?? parameters.path ?? parameters.dir_path ?? parameters.pattern ?? parameters.query;
  const text = typeof value === "string" ? value : JSON.stringify(parameters);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function pickFinalText(segments) {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].trim()) {
      return segments[index];
    }
  }
  return "";
}

export function runGemini(options) {
  const launch = options.launch ?? resolveGeminiLaunch();
  if (!launch) {
    return Promise.reject(new GeminiUnavailableError());
  }
  if (options.model && !MODEL_PATTERN.test(options.model)) {
    return Promise.reject(new Error(`Invalid model name "${options.model}".`));
  }

  const cliArgs = ["--output-format", "stream-json", "--approval-mode", options.approvalMode ?? "default"];
  if (options.model) {
    cliArgs.push("--model", options.model);
  }
  if (options.resumeSessionId) {
    cliArgs.push("--resume", options.resumeSessionId);
  } else if (options.sessionId) {
    cliArgs.push("--session-id", options.sessionId);
  }
  for (const policy of options.policyFiles ?? []) {
    cliArgs.push("--policy", policy);
  }
  cliArgs.push("--prompt", options.finalInstruction || "Respond to the request above.");

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const log = (line) => options.onLog?.(line);
    const spawnOptions = {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    };
    const child = launch.useShell
      ? spawn(buildShellLine(launch, cliArgs), { ...spawnOptions, shell: true })
      : spawn(launch.command, [...launch.prefixArgs, ...cliArgs], spawnOptions);

    const state = {
      sessionId: options.resumeSessionId ?? options.sessionId ?? null,
      model: null,
      segments: [""],
      toolCalls: [],
      warnings: [],
      errors: [],
      result: null,
      rawStdout: ""
    };
    let stdoutBuffer = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const handleLine = (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        state.rawStdout += `${line}\n`;
        log(`stdout: ${line}`);
        return;
      }
      switch (event.type) {
        case "init":
          state.sessionId = event.session_id ?? state.sessionId;
          state.model = event.model ?? state.model;
          log(`session ${state.sessionId} started (model ${state.model ?? "default"})`);
          break;
        case "message":
          if (event.role === "assistant" && typeof event.content === "string") {
            const last = state.segments.length - 1;
            state.segments[last] = event.delta ? state.segments[last] + event.content : event.content;
          }
          break;
        case "tool_use":
          state.toolCalls.push({ id: event.tool_id, name: event.tool_name, parameters: event.parameters ?? {}, status: "pending" });
          state.segments.push("");
          log(`tool ${event.tool_name} ${summarizeParams(event.parameters)}`);
          break;
        case "tool_result": {
          const call = state.toolCalls.find((candidate) => candidate.id === event.tool_id);
          if (call) {
            call.status = event.status ?? "success";
            call.error = event.error?.message ?? null;
          }
          if (event.status === "error") {
            log(`tool error: ${event.error?.message ?? "unknown"}`);
          }
          break;
        }
        case "error":
          (event.severity === "error" ? state.errors : state.warnings).push(String(event.message ?? ""));
          log(`${event.severity ?? "warning"}: ${event.message}`);
          break;
        case "result":
          state.result = event;
          log(`result: ${event.status}${event.error?.message ? ` (${event.error.message})` : ""}`);
          break;
        default:
          break;
      }
    };

    const timer =
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            log(`timed out after ${Math.round(options.timeoutMs / 1000)}s; stopping Gemini`);
            killProcessTree(child.pid);
          }, options.timeoutMs)
        : null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) {
          handleLine(line);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 200_000) {
        stderr = stderr.slice(-100_000);
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      options.onExit?.(child);
      if (!settled) {
        settled = true;
        reject(error.code === "ENOENT" ? new GeminiUnavailableError() : error);
      }
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      options.onExit?.(child);
      if (settled) {
        return;
      }
      settled = true;
      if (stdoutBuffer.trim()) {
        handleLine(stdoutBuffer.trim());
      }
      resolve({
        exitCode,
        signal,
        timedOut,
        timeoutMs: options.timeoutMs ?? null,
        durationMs: Date.now() - startedAt,
        sessionId: state.sessionId,
        model: state.model,
        text: pickFinalText(state.segments),
        transcript: state.segments.filter((segment) => segment.trim()).join("\n\n"),
        toolCalls: state.toolCalls,
        warnings: state.warnings,
        errors: state.errors,
        result: state.result,
        stderr: stderr.trim(),
        rawStdout: state.rawStdout.trim()
      });
    });

    options.onSpawn?.(child);
    child.stdin.on("error", () => {
      // Gemini may exit before reading stdin (for example on an auth error).
    });
    child.stdin.end(options.prompt ?? "", "utf8");
  });
}

export function isRunSuccessful(run) {
  return !run.timedOut && run.exitCode === 0 && run.result?.status !== "error" && Boolean(run.text.trim());
}

function lastLines(text, count) {
  return String(text ?? "")
    .trim()
    .split(/\r?\n/)
    .slice(-count)
    .join("\n");
}

export function classifyFailure(run) {
  const haystack = [run.stderr, ...run.errors, run.result?.error?.message ?? "", run.rawStdout].join("\n");
  if (run.timedOut) {
    const minutes = run.timeoutMs ? Math.round(run.timeoutMs / 60000) : null;
    return {
      kind: "timeout",
      message: `Gemini did not finish${minutes ? ` within ${minutes} minute(s)` : ""} and was stopped.`,
      hint: "Run it in the background (--background), narrow the scope, or raise --timeout-min."
    };
  }
  if (run.exitCode === AUTH_EXIT_CODE || /Please set an Auth method|UNAUTHENTICATED|invalid_grant|API key not valid|login required|re-?authenticate/i.test(haystack)) {
    return {
      kind: "auth",
      message: "The Gemini CLI is not signed in, or its credentials are no longer valid.",
      hint: "Open a terminal, run `gemini`, choose “Sign in with Google” and finish in the browser, then run /gemini:setup --check."
    };
  }
  if (/FatalUntrustedWorkspaceError|untrusted (folder|workspace)/i.test(haystack)) {
    return {
      kind: "trust",
      message: "Gemini refused to run because this folder is not trusted (Gemini's folder-trust feature is on).",
      hint: "Run `gemini` in this repository once and choose “Trust folder”, or set GEMINI_CLI_TRUST_WORKSPACE=true."
    };
  }
  if (/RESOURCE_EXHAUSTED|quota|rate[- ]?limit|\b429\b|usage limit/i.test(haystack)) {
    return {
      kind: "quota",
      message: "Gemini reported a quota or rate limit.",
      hint: "Wait for the limit to reset, or retry with --model flash."
    };
  }
  if (run.exitCode === TURN_LIMIT_EXIT_CODE) {
    return { kind: "turn-limit", message: "Gemini hit its session turn limit.", hint: "Start a fresh conversation (drop --resume)." };
  }
  if (run.exitCode === INPUT_ERROR_EXIT_CODE) {
    return { kind: "input", message: "Gemini rejected the request or its arguments.", hint: "See Gemini's output below." };
  }
  if (run.exitCode === 0 && !run.text.trim()) {
    return { kind: "empty", message: "Gemini finished without an answer.", hint: "Try again, or rephrase the request." };
  }
  return {
    kind: "error",
    message: run.result?.error?.message || lastLines(run.stderr, 1) || `Gemini exited with code ${run.exitCode}.`,
    hint: "See Gemini's output below and the job log."
  };
}

export function modelsUsed(run) {
  const models = run.result?.stats?.models;
  if (models && typeof models === "object" && Object.keys(models).length) {
    return Object.keys(models);
  }
  return run.model ? [run.model] : [];
}

export function usageSummary(run) {
  const stats = run.result?.stats;
  if (!stats) {
    return null;
  }
  return {
    inputTokens: Number.isFinite(stats.input_tokens) ? stats.input_tokens : null,
    outputTokens: Number.isFinite(stats.output_tokens) ? stats.output_tokens : null,
    totalTokens: Number.isFinite(stats.total_tokens) ? stats.total_tokens : null
  };
}

export function touchedFiles(run, workspaceRoot) {
  const files = new Set();
  for (const call of run.toolCalls) {
    if (!WRITE_TOOLS.has(call.name) || call.status !== "success") {
      continue;
    }
    const target = call.parameters?.file_path ?? call.parameters?.absolute_path ?? call.parameters?.path;
    if (typeof target !== "string" || !target) {
      continue;
    }
    const absolute = path.resolve(workspaceRoot, target);
    const relative = path.relative(workspaceRoot, absolute);
    files.add(relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : absolute);
  }
  return [...files].sort();
}
