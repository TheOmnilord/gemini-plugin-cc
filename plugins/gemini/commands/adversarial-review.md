---
description: Run a Gemini review that challenges the implementation approach, design choices and assumptions
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <pro|flash|id>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Gemini review through the plugin's companion script. It is a challenge review that questions the chosen approach, design choices, tradeoffs and assumptions, not just a stricter hunt for bugs.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only. Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Gemini's output verbatim.
- Keep the framing on whether the current approach is the right one, which assumptions it depends on, and where it could fail under real-world conditions.

Execution mode:
- If the raw arguments include `--wait`, run in the foreground without asking.
- If they include `--background`, run in a Claude background task without asking.
- Otherwise, estimate the size of the review first:
  - Working-tree review: `git status --short --untracked-files=all`, `git diff --shortstat --cached` and `git diff --shortstat`.
  - Branch review (`--base <ref>` or `--scope branch`): `git diff --shortstat <base>...HEAD`.
  - Untracked files count as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude that there is nothing to review when the relevant scope really is empty.
  - Recommend waiting only for a clearly tiny review (about 1-2 files). In every other case, including when unsure, recommend background.
- Then use `AskUserQuestion` exactly once with the options `Wait for results` and `Run in background`, recommended option first with ` (Recommended)` appended to its label.

Argument handling:
- Pass the user's arguments through unchanged. Do not strip `--wait` or `--background` (the script ignores them).
- Do not weaken the adversarial framing or rewrite the user's focus text; text after the flags goes to Gemini as the focus.

Foreground flow:
- Run with the Bash tool and `timeout: 600000`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" adversarial-review "--timeout-min 9 $ARGUMENTS"
```
- Return the command's stdout verbatim. Do not paraphrase, summarize or add commentary before or after it, and do not fix anything it mentions.

Background flow:
- Launch the review with the Bash tool in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" adversarial-review "$ARGUMENTS"`,
  description: "Gemini adversarial review",
  run_in_background: true
})
```
- Do not wait for it in this turn. Tell the user: "Gemini adversarial review started in the background. Check `/gemini:status` for progress and `/gemini:result` when it finishes."
