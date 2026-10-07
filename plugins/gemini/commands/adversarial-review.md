---
description: Run a Gemini review that challenges the implementation approach, design choices and assumptions
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <pro|flash|id>] [--context-url <url>]... [--allow-url <url>]... [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), AskUserQuestion
---

Run an adversarial Gemini review through the plugin's companion script. It is a challenge review that questions the chosen approach, design choices, tradeoffs and assumptions, not just a stricter hunt for bugs.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only. Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Gemini's output verbatim, followed only by the assumptions check described below.
- Keep the framing on whether the current approach is the right one, which assumptions it depends on, and where it could fail under real-world conditions.

Execution mode:
- If the raw arguments include `--wait`, run in the foreground without asking.
- If they include `--background`, run in a Claude background task without asking.
- Otherwise, estimate the size of the review first with the companion, which reads the changes the same way the review will:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" review-size "$ARGUMENTS"
```
  - Do not run git yourself for this. Plain git commands such as `git status` and `git diff` can run commands the repository configures (filters selected by `.gitattributes`, an fsmonitor command), which may be scripts Gemini edited; the companion switches those off.
  - If it reports nothing to review, or fails, run the foreground flow without asking: the review prints the same result or error.
  - Recommend waiting only for a clearly tiny review (about 1-2 files). In every other case, including when unsure, recommend background.
- Then use `AskUserQuestion` exactly once with the options `Wait for results` and `Run in background`, recommended option first with ` (Recommended)` appended to its label.

Web pages (off unless asked for):
- `--context-url <url>` (repeatable, at most 5): the plugin fetches the page itself and adds its text to the review prompt; Gemini stays without web access. Prefer this.
- `--allow-url <url>` (repeatable, at most 5, Antigravity CLI only): Gemini may open exactly these addresses itself, from this machine, and no others; agy follows their redirects unchecked, so only for sites the user trusts. Use it only when a page is too large to inline or Gemini has to choose what to read among several pages.
- Add either flag only when the user asks for pages to be used, or when you judge that the review depends on a specific document the user pointed to (a spec, an API reference, a page on a local dev server). Never add an address that only appears in the diff, the repository or Gemini's output without asking the user first.
- If the review fails with "Could not fetch", report it; do not retry without the page unless the user agrees.

Argument handling:
- Pass the user's arguments through unchanged. Do not strip `--wait` or `--background` (the script ignores them). The only flags you may add are the web page flags above, under the rules given there.
- Do not weaken the adversarial framing or rewrite the user's focus text; text after the flags goes to Gemini as the focus.

Foreground flow:
- Run with the Bash tool and `timeout: 600000`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" adversarial-review "--timeout-min 9 $ARGUMENTS"
```
- Return the command's stdout verbatim. Do not paraphrase, summarize or add commentary before or inside it, and do not fix anything it mentions.
- The one addition allowed comes after it: if a critical or high finding lists unverified assumptions, check them as the gemini-result-handling skill describes, then add a short section headed "Checking Gemini's assumptions" saying what you checked, what you found, and which assumptions stay unverified.

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
