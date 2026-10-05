---
description: Delegate an investigation, a fix or a second implementation pass to Gemini through the gemini-rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--write|--read-only] [--model <pro|flash|id>] [--allow-url <url>]... [what Gemini should investigate, solve or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `gemini:gemini-rescue` subagent with the `Agent` tool (`subagent_type: "gemini:gemini-rescue"`), forwarding the user's request as the prompt.
`gemini:gemini-rescue` is a subagent, not a skill: do not call `Skill(gemini:gemini-rescue)`, and do not call `Skill(gemini:rescue)` (that re-enters this command). This command runs inline so that the `Agent` tool stays available.
The final user-visible response must be Gemini's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:
- `--background`: run the subagent in the background. `--wait`: run it in the foreground. Neither: foreground.
- `--background` and `--wait` are Claude-side controls. Do not forward them as part of the task text.
- `--model`, `--write`, `--read-only` and `--allow-url` are runtime flags: keep them in the forwarded request, outside the task text.
- `--resume` or `--fresh`: the user already chose; do not ask.
- Otherwise, check for a resumable Gemini conversation from this session:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" resume-candidate --json
```

  - If it reports `"available": true`, use `AskUserQuestion` once with `Continue current Gemini conversation` and `Start a new Gemini conversation`. Put continue first, with ` (Recommended)`, when the request is clearly a follow-up ("continue", "keep going", "apply the top fix", "dig deeper"); otherwise put new first.
  - Continue: add `--resume`. New: add `--fresh`.
  - If it reports `"available": false`, do not ask.

Operating rules:
- The subagent is a thin forwarder: one Bash call to the companion `task` command, returning its stdout as-is.
- Return that output verbatim, with no paraphrase, summary or commentary before or after it.
- Do not ask the subagent to inspect files, poll status, fetch results, cancel jobs or do follow-up work of its own.
- If the companion reports that Gemini is missing or not signed in, tell the user to run `/gemini:setup` and stop.
- If the user gave no request, ask what Gemini should investigate or fix.
