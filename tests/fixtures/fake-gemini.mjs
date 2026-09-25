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
  process.stdout.write("0.0.0-fake\n");
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
    fs.appendFileSync(process.env.FAKE_GEMINI_CAPTURE, `${JSON.stringify({ args, prompt, cwd: process.cwd() })}\n`);
  }
  if (mode === "auth") {
    process.stderr.write("Please set an Auth method in your settings.json or specify GEMINI_API_KEY.\n");
    process.exit(41);
  }

  const emit = (event) => process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
  emit({ type: "init", session_id: flag("--resume") ?? flag("--session-id") ?? "fake-session", model: flag("--model") ?? "gemini-fake-pro" });
  if (mode === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 120_000));
  }
  emit({ type: "message", role: "assistant", content: "Let me look at the code first.", delta: true });
  emit({ type: "tool_use", tool_name: "read_file", tool_id: "t1", parameters: { file_path: "app.js" } });
  emit({ type: "tool_result", tool_id: "t1", status: "success", output: "(file contents)" });

  let answer;
  if (prompt.includes("<output_contract>")) {
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
