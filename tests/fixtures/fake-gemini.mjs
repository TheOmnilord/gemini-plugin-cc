#!/usr/bin/env node
// Stand-in for the Gemini CLI in tests: records its arguments and stdin, then
// answers in the same stream-json format as `gemini --output-format stream-json`.

import fs from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const mode = process.env.FAKE_GEMINI_MODE ?? "ok";

if (args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_GEMINI_VERSION ?? "0.61.0"}\n`);
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", async () => {
  const prompt = `${input}\n\n${flag("--prompt") ?? ""}`;
  if (process.env.FAKE_GEMINI_CAPTURE) {
    const env = { trust: process.env.GEMINI_CLI_TRUST_WORKSPACE || null, noColor: process.env.NO_COLOR || null };
    fs.appendFileSync(process.env.FAKE_GEMINI_CAPTURE, `${JSON.stringify({ args, prompt, cwd: process.cwd(), env })}\n`);
  }
  if (mode === "auth") {
    process.stderr.write("Please set an Auth method in your settings.json or specify GEMINI_API_KEY.\n");
    process.exit(41);
  }
  if (mode === "untrusted" && process.env.GEMINI_CLI_TRUST_WORKSPACE !== "true") {
    process.stderr.write(
      "Gemini CLI is not running in a trusted directory. To proceed, either use `--skip-trust`, set the `GEMINI_CLI_TRUST_WORKSPACE=true` environment variable, or trust this directory in interactive mode.\n"
    );
    process.exit(55);
  }
  if (mode === "old") {
    process.stderr.write("Unknown argument: session-id\n");
    process.exit(1);
  }

  const emit = (event) => process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
  emit({ type: "init", session_id: flag("--resume") ?? flag("--session-id") ?? "fake-session", model: flag("--model") ?? "gemini-fake-pro" });
  if (mode === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 120_000));
  }
  emit({ type: "message", role: "assistant", content: "Let me look at the code first.", delta: true });
  emit({ type: "tool_use", tool_name: "read_file", tool_id: "t1", parameters: { file_path: "app.js" } });
  emit({ type: "tool_result", tool_id: "t1", status: "success", output: "(file contents)" });

  if (mode === "web-refused") {
    emit({ type: "tool_use", tool_name: "web_fetch", tool_id: "t3", parameters: { prompt: "Read https://example.com/spec" } });
    emit({ type: "tool_result", tool_id: "t3", status: "error", error: { type: "policy_violation", message: "Tool execution denied by policy. Web access is off for reviews." } });
  } else if (mode === "missing-file") {
    // An ordinary failure, not a refusal, although the file is called policy.json.
    emit({ type: "tool_use", tool_name: "read_file", tool_id: "t4", parameters: { file_path: "policy.json" } });
    emit({ type: "tool_result", tool_id: "t4", status: "error", error: { type: "file_not_found", message: "File not found: policy.json" } });
  }

  let answer;
  if (prompt.includes("<output_contract>") && ["web-refused", "missing-file"].includes(mode)) {
    answer = JSON.stringify({ verdict: "approve", summary: "Nothing material.", findings: [], next_steps: [] });
  } else if (prompt.includes("<output_contract>")) {
    answer = JSON.stringify({
      verdict: "needs-attention",
      summary: "average() divides by zero for an empty list.",
      findings: [
        { severity: "low", title: "Unclear name", body: "xs is terse.", file: "app.js", line_start: 1, line_end: 1, confidence: 0.3, recommendation: "Rename it." },
        {
          severity: "high",
          title: "Empty list crashes average()",
          body: "The \\@param doc promises numbers, but xs.length can be 0.",
          file: "app.js",
          line_start: 2,
          line_end: 3,
          confidence: 0.9,
          recommendation: "Return 0 or throw for an empty list."
        }
      ],
      next_steps: ["Add a test for an empty list."]
    });
  } else if (args.includes("auto_edit")) {
    emit({ type: "tool_use", tool_name: "write_file", tool_id: "t2", parameters: { file_path: "fixed.js", content: "x" } });
    emit({ type: "tool_result", tool_id: "t2", status: "success" });
    answer = "Fixed the bug in fixed.js.";
  } else {
    answer = `Answer from fake Gemini. Resumed: ${Boolean(flag("--resume"))}.`;
  }

  emit({ type: "message", role: "assistant", content: answer.slice(0, 12), delta: true });
  emit({ type: "message", role: "assistant", content: answer.slice(12), delta: true });
  emit({
    type: "result",
    status: "success",
    stats: { total_tokens: 1234, input_tokens: 1200, output_tokens: 34, models: { "gemini-fake-pro": {} } }
  });
});
