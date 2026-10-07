---
description: Run a Gemini code review of your local git changes (working tree or branch)
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <pro|flash|id>] [--context-url <url>]... [--allow-url <url>]... [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Gemini code review through the plugin's companion script.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only. Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Gemini's output verbatim, followed only by the assumptions check described below.

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

Web pages (off unless asked for):
- `--context-url <url>` (repeatable, at most 5): the plugin fetches the page itself and adds its text to the review prompt; Gemini stays without web access. Prefer this.
- `--allow-url <url>` (repeatable, at most 5, Antigravity CLI only): Gemini may open exactly these addresses itself, from this machine, and no others; agy follows their redirects unchecked, so only for sites the user trusts. Use it only when a page is too large to inline or Gemini has to choose what to read among several pages.
- Add either flag only when the user asks for pages to be used, or when you judge that the review depends on a specific document the user pointed to (a spec, an API reference, a page on a local dev server). Never add an address that only appears in the diff, the repository or Gemini's output without asking the user first.
- If the review fails with "Could not fetch", report it; do not retry without the page unless the user agrees.

Argument handling:
- Pass the user's arguments through unchanged. Do not strip `--wait` or `--background` (the script ignores them) and do not add review instructions of your own. The only flags you may add are the web page flags above, under the rules given there.
- Any text after the flags is passed to Gemini as a focus hint.

Foreground flow:
- Run with the Bash tool and `timeout: 600000`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" review "--timeout-min 9 $ARGUMENTS"
```
- Return the command's stdout verbatim. Do not paraphrase, summarize or add commentary before or inside it, and do not fix anything it mentions.
- The one addition allowed comes after it: if a critical or high finding lists unverified assumptions, check them as the gemini-result-handling skill describes, then add a short section headed "Checking Gemini's assumptions" saying what you checked, what you found, and which assumptions stay unverified.

Background flow:
- Launch the review with the Bash tool in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" review "$ARGUMENTS"`,
  description: "Gemini review",
  run_in_background: true
})
```
- Do not wait for it in this turn. Tell the user: "Gemini review started in the background. Check `/gemini:status` for progress and `/gemini:result` when it finishes."
