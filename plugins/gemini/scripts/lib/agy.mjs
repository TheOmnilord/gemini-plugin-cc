// Runs Google's Antigravity CLI (agy) headless for the companion and reads its
// stream-json events into the same run shape as the Gemini CLI runner.
//
// Every run uses a private agy profile in the plugin's data folder. agy keeps
// its settings, custom agents, hooks and conversations under the home folder,
// so the companion points USERPROFILE and HOME at that profile. The sign-in
// lives in the OS keyring, so it carries over from the user's own agy.
//
// The profile holds:
// - one agent, gemini-cc, whose tool list offers file reading, search, file
//   edits and web tools only. agy keeps a resumed conversation on the agent
//   that started it, so a single agent lets a read-only conversation continue
//   in write mode;
// - settings that deny shell commands, browser actions and MCP tools;
// - a PreToolUse hook (agy-guard.mjs) that checks every tool call: it blocks
//   edits in read-only runs and keeps them inside the repository otherwise,
//   because headless agy would approve file writes anywhere on disk.
//
// The prompt goes in on stdin as one stream-json message, so its size is not
// limited by the command line.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { GeminiUnavailableError } from "./gemini.mjs";
import { dataRoot } from "./jobs.mjs";
import { killProcessTree, runCommand } from "./proc.mjs";

export const DEFAULT_AGY_MODEL = "gemini-3.8-flash-medium";
export const AGY_INSTALL_COMMAND =
  process.platform === "win32"
    ? "irm https://antigravity.google/cli/install.ps1 | iex"
    : "curl -fsSL https://antigravity.google/cli/install.sh | bash";
// The same installer as a command line for the Bash tool (Git Bash on Windows).
export const AGY_INSTALL_SHELL_COMMAND =
  process.platform === "win32"
    ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"'
    : AGY_INSTALL_COMMAND;
export const AGY_SIGN_IN_STEP = "Sign in once: open a terminal, run `agy`, sign in with your Google account in the browser, then type `/exit`.";
export const MODEL_ALIASES = {
  auto: DEFAULT_AGY_MODEL,
  flash: "gemini-3.8-flash-medium",
  "flash-high": "gemini-3.8-flash-high",
  "flash-low": "gemini-3.8-flash-low",
  "flash-lite": "gemini-3.8-flash-low",
  pro: "gemini-3.1-pro-high",
  "pro-low": "gemini-3.1-pro-low"
};
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]+$/;
const SIGNED_OUT = /please sign in|not signed in|sign in to|signed out|login required|not logged in|unauthenticated|re-?authenticate/i;
const AGENT = "gemini-cc";
const READ_TOOLS = ["view_file", "list_dir", "grep_search", "find_by_name"];
const EDIT_TOOLS = ["write_to_file", "replace_file_content", "multi_replace_file_content"];
const WEB_TOOLS = ["search_web", "read_url_content"];
const TOUCH_TOOLS = new Set([...EDIT_TOOLS, "sed_file", "notebook_edit"]);
const GUARD_SOURCE = fileURLToPath(new URL("../agy-guard.mjs", import.meta.url));
const GUARD_FILE = "gemini-cc-guard.mjs";
// Headless agy refuses, and ends the run on, any page read and any file read
// outside the workspace, including the copy of a fetched page that it keeps
// in the profile's brain folder. The guard hook runs first and admits only
// listed addresses and the current conversation's folder, so agy allows page
// reads and file reads in brain/, and keeps its own check on other files.
// agy compares long paths, so the folder is named by its real path (a short
// 8.3 name such as ADMINI~1 would not match).
function profilePermissions(cliDir) {
  const brainDir = path.join(cliDir, "brain");
  fs.mkdirSync(brainDir, { recursive: true });
  return {
    allow: ["read_url(*)", `read_file(${fs.realpathSync.native(brainDir)})`],
    deny: ["command(*)", "unsandboxed(*)", "execute_url(*)", "mcp(*)"]
  };
}
// agy starts hook commands through cmd /c or sh -c from the folder that holds
// hooks.json, and on Windows it mangles quoted arguments, so the guard sits in
// that folder and is started by its bare name.
const HOOKS = {
  "gemini-cc-guard": {
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node ${GUARD_FILE}`, timeout: 20 }] }]
  }
};
const AGENT_DEFINITION = [
  "---",
  `name: ${AGENT}`,
  "description: Gemini as a second engineer for Claude Code - reviews, second opinions and bounded fixes.",
  `tools: [${[...READ_TOOLS, ...EDIT_TOOLS, ...WEB_TOOLS, "finish"].join(", ")}]`,
  "mainAgent: true",
  "subagent: false",
  "---",
  "",
  "You are Gemini, working as an independent second engineer for Claude Code (Anthropic's coding agent) on the repository in your working directory. Claude and its user sent the request.",
  "",
  "- Explore the repository with view_file, list_dir, grep_search and find_by_name before making claims about it.",
  "- Each request states whether this turn may edit files. When it says read-only, do not call the file-editing tools: describe the change instead (file, location, replacement code). When edits are allowed, keep them inside the repository, never inside .git, and scoped to the request.",
  "- There is no shell: you cannot run commands, builds or tests. Name the commands Claude should run instead.",
  "- Web search is switched off for some runs, and you may open only the web addresses a request lists. Otherwise work from the repository.",
  "- When a tool call is refused, carry on without it. Never stop the request to report the refusal or to ask for more permissions: they cannot be granted from inside a run.",
  "- Cite files as repository-relative path:line in plain text, not as links.",
  "- Follow the output format the request asks for.",
  ""
].join("\n");

const AGY_MISSING_MESSAGE = `The Antigravity CLI (agy) was not found. Install it with \`${AGY_INSTALL_COMMAND}\`, sign in once by running \`agy\`, then run /gemini:setup.`;

export function agyUnavailableError() {
  return new GeminiUnavailableError(AGY_MISSING_MESSAGE);
}

export function resolveAgyModel(model) {
  const requested = String(model ?? "").trim();
  if (!requested) {
    return DEFAULT_AGY_MODEL;
  }
  return MODEL_ALIASES[requested.toLowerCase()] ?? requested;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function defaultInstallDir() {
  return process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "agy", "bin")
    : path.join(os.homedir(), ".local", "bin");
}

export function resolveAgyLaunch() {
  const override = process.env.GEMINI_COMPANION_AGY?.trim();
  if (override) {
    if (/\.(c|m)?js$/i.test(override)) {
      return { command: process.execPath, prefixArgs: [path.resolve(override)], source: override };
    }
    return { command: /[\\/]/.test(override) ? path.resolve(override) : override, prefixArgs: [], source: override };
  }
  // The installer adds its folder to PATH, but only for terminals opened afterwards.
  const name = process.platform === "win32" ? "agy.exe" : "agy";
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), defaultInstallDir()];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isFile(candidate)) {
      return { command: candidate, prefixArgs: [], source: candidate };
    }
  }
  return null;
}

export function agyProfileDir() {
  return path.join(dataRoot(), "agy-profile");
}

function writeIfChanged(file, content) {
  try {
    if (fs.readFileSync(file, "utf8") === content) {
      return;
    }
  } catch {
    // Missing: write it.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  try {
    fs.renameSync(temporary, file);
  } catch {
    // Windows can refuse the rename while agy reads the file.
    fs.writeFileSync(file, content, "utf8");
    fs.rmSync(temporary, { force: true });
  }
}

// Brings the private profile up to date. It is cheap when nothing changed, so
// it runs before every agy call and also picks up plugin updates.
export function ensureAgyProfile(profile = agyProfileDir()) {
  const cliDir = path.join(profile, ".gemini", "antigravity-cli");
  const configDir = path.join(profile, ".gemini", "config");
  const settingsFile = path.join(cliDir, "settings.json");
  let settings = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed;
    }
  } catch {
    // Missing or unreadable: start from an empty object.
  }
  // Keys agy stores itself are kept; the permissions belong to the plugin.
  writeIfChanged(settingsFile, `${JSON.stringify({ ...settings, permissions: profilePermissions(cliDir) }, null, 2)}\n`);
  writeIfChanged(path.join(configDir, "hooks.json"), `${JSON.stringify(HOOKS, null, 2)}\n`);
  writeIfChanged(path.join(configDir, GUARD_FILE), fs.readFileSync(GUARD_SOURCE, "utf8"));
  writeIfChanged(path.join(configDir, "agents", `${AGENT}.md`), AGENT_DEFINITION);
  return profile;
}

function withEnv(base, updates) {
  const env = { ...base };
  for (const [name, value] of Object.entries(updates)) {
    // Windows environment names ignore case: replace an entry, do not add a twin.
    if (process.platform === "win32") {
      for (const key of Object.keys(env)) {
        if (key !== name && key.toUpperCase() === name.toUpperCase()) {
          delete env[key];
        }
      }
    }
    env[name] = value;
  }
  return env;
}

// agy's environment: the private profile as its home folder, this run's
// permissions for the guard, and this Node on PATH for the guard hook.
export function agyEnv({ write = false, web = false, allowUrls = [], profile = agyProfileDir() } = {}, extra = {}) {
  return withEnv(process.env, {
    USERPROFILE: profile,
    HOME: profile,
    GEMINI_CC_PROFILE: profile,
    GEMINI_CC_MODE: write ? "write" : "read-only",
    GEMINI_CC_WEB: web ? "1" : "0",
    GEMINI_CC_WEB_ALLOW: JSON.stringify(allowUrls ?? []),
    PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
    NO_COLOR: "1",
    ...extra
  });
}

function lastLine(text) {
  return (
    String(text ?? "")
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .pop() ?? ""
  );
}

export function getAgyVersion(launch) {
  const result = runCommand(launch.command, [...launch.prefixArgs, "--version"], { timeout: 30000 });
  const output = lastLine(result.stdout);
  return result.status === 0 && output ? output : null;
}

// `agy models` needs a signed-in account, so it doubles as the sign-in check.
export function listAgyModels(launch) {
  const profile = ensureAgyProfile();
  const result = runCommand(launch.command, [...launch.prefixArgs, "models"], { timeout: 60000, env: agyEnv({ profile }) });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) {
    return {
      ok: false,
      signedIn: SIGNED_OUT.test(output) ? false : null,
      message: lastLine(output) || result.error?.message || `agy models exited with code ${result.status}.`
    };
  }
  const models = String(result.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^fetching\b/i.test(line))
    .map((line) => {
      const [slug, ...name] = line.split(/\t+/);
      return { slug: slug.trim(), name: name.join(" ").trim() || slug.trim() };
    });
  return { ok: true, signedIn: true, models };
}

function summarizeParams(parameters) {
  if (!parameters || typeof parameters !== "object") {
    return "";
  }
  const value =
    parameters.TargetFile ??
    parameters.AbsolutePath ??
    parameters.DirectoryPath ??
    parameters.SearchPath ??
    parameters.SearchDirectory ??
    parameters.Query ??
    parameters.query ??
    parameters.Url;
  const text = typeof value === "string" ? value : JSON.stringify(parameters);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function repoRelative(file, workspaceRoot) {
  const relative = workspaceRoot ? path.relative(workspaceRoot, file) : "";
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : file;
}

// agy's models like to cite files as [label](file:///C:/repo/app.js#L6-L9)
// links, which read badly in a terminal; they become `app.js:6-9` instead.
export function plainFileLinks(text, workspaceRoot) {
  return String(text ?? "").replace(/\[([^\]\n]*)\]\((file:\/\/\/[^)\s#]+)(?:#L(\d+)(?:-L?(\d+))?)?\)/g, (match, label, url, start, end) => {
    let file;
    try {
      file = fileURLToPath(url);
    } catch {
      return match;
    }
    const where = `${repoRelative(file, workspaceRoot)}${start ? `:${start}${end && end !== start ? `-${end}` : ""}` : ""}`;
    const name = label.replace(/`/g, "").trim();
    return !name || name === path.basename(file) || where.startsWith(name) ? `\`${where}\`` : `${label} (\`${where}\`)`;
  });
}

export function runAgy(options) {
  const launch = options.launch ?? resolveAgyLaunch();
  if (!launch) {
    return Promise.reject(agyUnavailableError());
  }
  const model = resolveAgyModel(options.model);
  if (!MODEL_PATTERN.test(model)) {
    return Promise.reject(new Error(`Invalid model name "${model}".`));
  }

  const profile = ensureAgyProfile();
  const cliArgs = [
    "-p",
    "",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    "--agent",
    AGENT,
    "--model",
    model
  ];
  if (options.resumeSessionId) {
    cliArgs.push("--conversation", options.resumeSessionId);
  }
  if (options.jsonSchemaFile) {
    cliArgs.push("--json-schema", options.jsonSchemaFile);
  }
  const message = [options.prompt, options.finalInstruction].filter((part) => part?.trim()).join("\n\n");

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const log = (line) => options.onLog?.(line);
    const child = spawn(launch.command, [...launch.prefixArgs, ...cliArgs], {
      cwd: options.cwd,
      env: agyEnv({ write: options.write, web: options.web, allowUrls: options.allowUrls, profile }, options.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });

    const state = { sessionId: options.resumeSessionId ?? null, model: null, texts: new Map(), toolCalls: new Map(), errors: [], result: null, rawStdout: "" };
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
      if (event.event === "init") {
        state.sessionId = event.conversation_id ?? state.sessionId;
        state.model = event.init?.model ?? state.model;
        log(`conversation ${state.sessionId} started (model ${state.model ?? model})`);
      } else if (event.event === "step_update") {
        const step = event.step_update ?? {};
        const index = Number(step.step_index);
        if (step.step_type === "agent_response") {
          if (typeof step.text_delta === "string") {
            state.texts.set(index, (state.texts.get(index) ?? "") + step.text_delta);
          }
        } else if (step.step_type === "tool") {
          let call = state.toolCalls.get(index);
          if (!call) {
            call = { id: index, name: step.tool_name ?? step.tool_info?.name ?? "tool", parameters: step.tool_info?.parameters ?? {}, status: "pending", error: null };
            state.toolCalls.set(index, call);
            log(`tool ${call.name} ${summarizeParams(call.parameters)}`);
          }
          if (step.state === "DONE") {
            call.status = "success";
          } else if (step.state === "ERROR") {
            call.status = "error";
            call.error = step.tool_info?.error?.message ?? "failed";
            log(`tool ${call.name} failed: ${call.error.length > 240 ? `${call.error.slice(0, 237)}...` : call.error}`);
          }
        }
      } else if (event.event === "result") {
        state.result = event.result ?? {};
        log(`result: ${state.result.status ?? "unknown"}`);
      } else if (event.error) {
        state.errors.push(typeof event.error === "string" ? event.error : String(event.error.message ?? JSON.stringify(event.error)));
      }
    };

    const timer =
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            log(`timed out after ${Math.round(options.timeoutMs / 1000)}s; stopping agy`);
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
        reject(error.code === "ENOENT" ? agyUnavailableError() : error);
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
      // result.response joins every message of the turn; the answer is the last one.
      const segments = [...state.texts.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => plainFileLinks(text, options.cwd));
      const answers = segments.filter((text) => text.trim());
      const response = typeof state.result?.response === "string" ? plainFileLinks(state.result.response, options.cwd) : "";
      resolve({
        exitCode,
        signal,
        timedOut,
        timeoutMs: options.timeoutMs ?? null,
        durationMs: Date.now() - startedAt,
        sessionId: state.sessionId,
        model: state.model ?? model,
        text: answers.at(-1) ?? response,
        transcript: answers.join("\n\n") || response,
        structured: state.result?.structured_output ?? null,
        toolCalls: [...state.toolCalls.values()],
        deniedActions: Array.isArray(state.result?.denied_actions) ? state.result.denied_actions : [],
        warnings: [],
        errors: state.errors,
        result: state.result,
        stderr: stderr.trim(),
        rawStdout: state.rawStdout.trim()
      });
    });

    options.onSpawn?.(child);
    child.stdin.on("error", () => {
      // agy may exit before reading stdin, for example on a bad flag.
    });
    child.stdin.end(`${JSON.stringify({ event: "user", message: { content: message } })}\n`, "utf8");
  });
}

export function isAgyRunSuccessful(run) {
  return (
    !run.timedOut &&
    run.exitCode === 0 &&
    String(run.result?.status ?? "").toUpperCase() === "SUCCESS" &&
    (Boolean(run.text.trim()) || run.structured != null)
  );
}

export function classifyAgyFailure(run) {
  const resultError = run.result?.error;
  const resultMessage = typeof resultError === "string" ? resultError : resultError?.message ?? "";
  const haystack = [run.stderr, ...run.errors, resultMessage, run.rawStdout].join("\n");
  if (run.timedOut) {
    const minutes = run.timeoutMs ? Math.round(run.timeoutMs / 60000) : null;
    return {
      kind: "timeout",
      message: `Gemini did not finish${minutes ? ` within ${minutes} minute(s)` : ""} and was stopped.`,
      hint: "Run it in the background (--background), narrow the scope, or raise --timeout-min."
    };
  }
  if (SIGNED_OUT.test(haystack)) {
    return {
      kind: "auth",
      message: "The Antigravity CLI is not signed in, or its sign-in has expired.",
      hint: `${AGY_SIGN_IN_STEP} Then run /gemini:setup --check.`
    };
  }
  if (/quota|rate[- ]?limit|RESOURCE_EXHAUSTED|\b429\b|\bcredits?\b|usage limit|limit reached/i.test(haystack)) {
    return {
      kind: "quota",
      message: "Gemini reported a quota or usage limit for your plan.",
      hint: "Wait for the limit to reset, or retry with a lighter model (--model flash-low). Running `agy` and typing /usage shows your quota."
    };
  }
  if (/unknown model|invalid model|model\b[^\n]*\b(not found|not available|unavailable|not supported)/i.test(haystack)) {
    return {
      kind: "model",
      message: "agy does not offer the requested model to this account.",
      hint: "Run `agy models` to list your models, then pass --model <model> or set GEMINI_COMPANION_MODEL."
    };
  }
  if (run.exitCode === 2 || /flag provided but not defined|unknown (flag|argument)|as its prompt/i.test(haystack)) {
    return {
      kind: "version",
      message: "agy rejected the plugin's command line, so the installed agy probably differs from the one the plugin was built for.",
      hint: "Update it with `agy update`, then run /gemini:setup."
    };
  }
  if (run.exitCode === 0 && !run.text.trim() && run.structured == null) {
    if (run.deniedActions.length || /no output produced/i.test(haystack)) {
      const actions = run.deniedActions.map((action) => action.display_name ?? action.action).filter(Boolean).join(", ");
      return {
        kind: "blocked",
        message: `Gemini stopped because it needed an action this run does not allow${actions ? ` (${actions})` : ""}.`,
        hint: "Rephrase the request so Gemini can answer from the files alone, or use --write when it has to edit files."
      };
    }
    return { kind: "empty", message: "Gemini finished without an answer.", hint: "Try again, or rephrase the request." };
  }
  return {
    kind: "error",
    message: resultMessage || lastLine(run.stderr) || `agy exited with code ${run.exitCode}.`,
    hint: "See the output below and the job log."
  };
}

export function agyModelsUsed(run) {
  return run.model ? [run.model] : [];
}

export function agyUsageSummary(run) {
  const usage = run.result?.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const count = (value) => (Number.isFinite(value) ? value : null);
  return { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens), totalTokens: count(usage.total_tokens) };
}

export function agyTouchedFiles(run, workspaceRoot) {
  const files = new Set();
  for (const call of run.toolCalls) {
    if (!TOUCH_TOOLS.has(call.name) || call.status !== "success") {
      continue;
    }
    const target = call.parameters?.TargetFile ?? call.parameters?.FilePath ?? call.parameters?.AbsolutePath;
    if (typeof target === "string" && target) {
      files.add(repoRelative(path.resolve(workspaceRoot, target), workspaceRoot));
    }
  }
  return [...files].sort();
}
