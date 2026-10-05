---
name: gemini-cli-runtime
description: Internal contract for calling the Gemini companion runtime from Claude Code
user-invocable: false
---

# Gemini runtime

Use this only inside the `gemini:gemini-rescue` subagent.

Primary helper, with the task text on stdin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task [flags] <<'GEMINI_TASK'
<task text>
GEMINI_TASK
```

The companion reaches Gemini through the Antigravity CLI (`agy`) by default, or through the Gemini CLI when the user opted in; the flags are the same.

Flags that `task` understands:
- (default) read-only: Gemini can read and search the repository and search the web, but cannot edit files, run commands or open web pages.
- `--write`: Gemini may create and edit files inside the repository (never inside `.git`; with the Gemini CLI, build files such as package.json also stay read-only). Shell commands stay disabled, so it cannot run builds or tests.
- `--resume-last`: continue the most recent Gemini conversation in this repository (this Claude session's first), including a read-only one in write mode. Send only the new instruction.
- `--model <pro|flash|flash-lite|auto|model-id>`.
- `--allow-url <url>` (repeatable, at most 5, Antigravity CLI only): Gemini may open exactly these web addresses. Only when the request names them.
- `--background`: start a detached job and print its ID; the user follows up with `/gemini:status` and `/gemini:result`.
- `--timeout-min <n>`: stop Gemini after n minutes. Use 9 for foreground calls, because the Bash tool gives up at 10.

Execution rules:
- Exactly one `task` call per handoff. Do not call `setup`, `review`, `adversarial-review`, `ask`, `status`, `result` or `cancel` from the subagent.
- Use the helper rather than running `agy` or `gemini` directly or doing any other Bash work.
- Always pass the task text through a quoted heredoc (`<<'GEMINI_TASK'`), never as a quoted argument, so quotes, backticks and dollar signs survive.
- Return stdout unchanged. If the call fails or Gemini cannot be invoked, return nothing.
