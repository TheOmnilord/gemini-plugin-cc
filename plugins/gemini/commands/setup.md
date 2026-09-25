---
description: Check that the Gemini CLI is installed and signed in; --check also sends a live test request
argument-hint: '[--check] [--model <pro|flash|id>]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Check whether Gemini is ready to use from Claude Code.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup "$ARGUMENTS"
```

If the report says the Gemini CLI is not installed, or is too old, and npm is available:
- Use `AskUserQuestion` once, with the options `Install Gemini CLI (Recommended)` (or `Update Gemini CLI (Recommended)` when it is too old) and `Skip for now`.
- If the user chooses to install or update, run `npm install -g @google/gemini-cli` with the Bash tool and `timeout: 600000`, then run the setup command again.

Output rules:
- Present the final setup report as returned.
- If Gemini is installed but not signed in, keep the sign-in guidance. The user signs in by running `gemini` in their own terminal and choosing **Sign in with Google**, or by putting `GEMINI_API_KEY=...` in `~/.gemini/.env`. Never ask the user to paste an API key, token or password into this chat, and never try to complete the sign-in yourself.
- If `--check` was not passed and everything else looks ready, mention that `/gemini:setup --check` confirms it with a live request.
