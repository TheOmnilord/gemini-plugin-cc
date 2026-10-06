#!/usr/bin/env node
// Stand-in for the Antigravity CLI (agy) in tests: records its arguments,
// environment and stdin, then answers in agy's stream-json format.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const mode = process.env.FAKE_AGY_MODE ?? "ok";
const MODELS = ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "gemini-3.1-pro-high", "gemini-3.1-pro-low"];

if (args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_AGY_VERSION ?? "1.2.11"}\n`);
  process.exit(0);
}

if (args.includes("--help")) {
  // agy 1.3.0 lists --mode; FAKE_AGY_VERSION below 1.3 leaves it out, as older agy may.
  const old = /^1\.[0-2]\./.test(process.env.FAKE_AGY_VERSION ?? "1.3.0");
  const lines = ["Usage of agy.exe:", "  --agent   Agent for the current CLI session"];
  if (!old) {
    lines.push("  --mode    Set the agent execution mode for this session (accept-edits, plan)");
  }
  lines.push("  --model   Model for the current CLI session");
  process.stderr.write(`${lines.join("\n")}\n`);
  process.exit(0);
}

if (args[0] === "models") {
  process.stdout.write("Fetching available models...\n");
  if (mode === "signed-out") {
    process.stderr.write("Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n");
    process.exit(1);
  }
  process.stdout.write(`${MODELS.map((model) => `${model}\t${model}`).join("\n")}\n`);
  process.exit(0);
}

// Like agy, -p takes the next argument as its prompt.
const printIndex = args.indexOf("-p");
if (printIndex === -1 || String(args[printIndex + 1]).startsWith("--")) {
  process.stderr.write(`Error: -p took "${args[printIndex + 1]}" as its prompt.\n`);
  process.exit(2);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", async () => {
  const message = input
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line).message?.content ?? "")
    .join("\n");
  const home = process.env.HOME ?? "";
  if (process.env.FAKE_AGY_CAPTURE) {
    const env = {
      home,
      userProfile: process.env.USERPROFILE ?? null,
      mode: process.env.GEMINI_CC_MODE ?? null,
      web: process.env.GEMINI_CC_WEB ?? null,
      webAllow: process.env.GEMINI_CC_WEB_ALLOW ?? null,
      profile: process.env.GEMINI_CC_PROFILE ?? null,
      noColor: process.env.NO_COLOR ?? null
    };
    const profileReady = fs.existsSync(path.join(home, ".gemini", "config", "hooks.json"));
    fs.appendFileSync(process.env.FAKE_AGY_CAPTURE, `${JSON.stringify({ args, message, cwd: process.cwd(), env, profileReady })}\n`);
  }

  const model = flag("--model");
  if (mode === "signed-out") {
    process.stderr.write("Error: You are not signed in. Launch the CLI without arguments to sign in.\n");
    process.exit(1);
  }
  if (mode === "quota") {
    process.stderr.write("Error: RESOURCE_EXHAUSTED: you have reached the usage limit for your plan.\n");
    process.exit(1);
  }
  if (!MODELS.includes(model)) {
    process.stderr.write(`Error: unknown model "${model}".\n`);
    process.exit(1);
  }

  const conversation = flag("--conversation") ?? randomUUID();
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const step = (fields) => emit({ event: "step_update", step_update: { conversation_id: conversation, ...fields } });
  let index = 0;
  const tool = (name, parameters, state = "DONE", error = null) => {
    const stepIndex = index++;
    step({ step_index: stepIndex, state: "ACTIVE", step_type: "tool", tool_name: name, tool_info: { name, parameters } });
    step({ step_index: stepIndex, state, step_type: "tool", tool_name: name, tool_info: { name, parameters, ...(error ? { error: { type: "TOOL_ERROR", message: error } } : {}) } });
  };
  const say = (text) => {
    const stepIndex = index++;
    step({ step_index: stepIndex, state: "ACTIVE", step_type: "agent_response", text_delta: text.slice(0, 10) });
    step({ step_index: stepIndex, state: "DONE", step_type: "agent_response", text_delta: text.slice(10) });
  };
  const usage = { input_tokens: 2100, output_tokens: 42, thinking_tokens: 7, cache_read_tokens: 0, total_tokens: 2142 };

  emit({ event: "init", conversation_id: conversation, init: { model, cwd: process.cwd(), tools: ["view_file", "run_command"], permission_mode: "request-review" } });
  step({ step_index: index++, state: "DONE", step_type: "user_input" });
  if (mode === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 120_000));
  }

  if (mode === "cancelled-mid-run") {
    // A cancel arrives while agy runs, and agy is stopped: file the cancel
    // marker for the running job, then die the way a killed process does.
    const state = path.join(process.env.GEMINI_COMPANION_DATA, "state");
    for (const workspace of fs.readdirSync(state)) {
      const jobs = path.join(state, workspace, "jobs");
      for (const name of fs.readdirSync(jobs).filter((file) => file.endsWith(".json"))) {
        if (JSON.parse(fs.readFileSync(path.join(jobs, name), "utf8")).status === "running") {
          fs.writeFileSync(path.join(jobs, name.replace(/\.json$/, ".cancel")), "");
        }
      }
    }
    process.stderr.write("terminated\n");
    process.exit(1);
  }

  if (mode === "denied") {
    tool("run_command", { CommandLine: "npm test" }, "ERROR", 'permission check failed for command "npm test": user denied permission');
    process.stderr.write("jetski: no output produced — a tool required the \"command\" permission that headless mode cannot prompt for, so it was auto-denied.\n");
    emit({ event: "result", result: { conversation_id: conversation, status: "SUCCESS", response: "", usage, denied_actions: [{ action: "command", display_name: "RunCommand" }] } });
    process.exit(0);
  }

  say("Let me look at the code first.");
  tool("view_file", { AbsolutePath: path.join(process.cwd(), "app.js") });

  let answer;
  let structured = null;
  if (mode.startsWith("web-refused")) {
    tool("read_url_content", { Url: "https://example.com/spec" }, "ERROR", "tool call denied by pre-tool hook: Web access is off for this Gemini run.");
  }
  if (mode === "outside-refused") {
    // Tries a file outside the repository, is refused, and carries on reading.
    tool("view_file", { AbsolutePath: path.join(path.dirname(process.cwd()), "settings.json") }, "ERROR", "tool call denied by pre-tool hook: view_file may only read inside the repository.");
    tool("view_file", { AbsolutePath: path.join(process.cwd(), "app.js") });
  }
  if (["web-refused", "outside-refused"].includes(mode) && flag("--json-schema")) {
    // Gives up after the refusal, as Gemini sometimes does, or reviews and finds nothing.
    const summary = mode === "web-refused" ? "Could not review: read_url is not permitted. Add a read_url permission." : "Nothing material.";
    structured = { verdict: "approve", summary, findings: [], next_steps: [] };
    tool("finish", structured);
    answer = JSON.stringify(structured);
  } else if (flag("--json-schema")) {
    structured = {
      verdict: "needs-attention",
      summary: "average() divides by zero for an empty list.",
      findings: [
        { severity: "low", title: "Unclear name", body: "xs is terse.", file: "app.js", line_start: 1, line_end: 1, confidence: 0.3, recommendation: "Rename it." },
        {
          severity: "high",
          title: "Empty list crashes average()",
          body: "The @param doc promises numbers, but xs.length can be 0.",
          file: "app.js",
          line_start: 2,
          line_end: 3,
          confidence: 0.9,
          recommendation: "Return 0 or throw for an empty list."
        }
      ],
      next_steps: ["Add a test for an empty list."]
    };
    tool("finish", structured);
    answer = JSON.stringify(structured);
  } else if (process.env.GEMINI_CC_MODE === "write") {
    tool("write_to_file", { TargetFile: path.join(process.cwd(), "fixed.js") });
    answer = `Fixed the bug in [fixed.js](${pathToFileURL(path.join(process.cwd(), "fixed.js")).href}#L2).`;
  } else {
    answer = `Answer from fake agy. Resumed: ${Boolean(flag("--conversation"))}.`;
  }
  say(answer);
  emit({
    event: "result",
    result: {
      conversation_id: conversation,
      status: "SUCCESS",
      response: `Let me look at the code first.\n${answer}`,
      usage,
      ...(structured ? { structured_output: structured } : {})
    }
  });
});
