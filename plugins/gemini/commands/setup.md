---
description: Check that Gemini is ready to use (the Antigravity CLI, or the Gemini CLI when opted in), its sign-in and model; --check also sends a live test request
argument-hint: '[--check] [--model <pro|flash|id>]'
allowed-tools: Bash(node:*), Bash(npm:*), Bash(powershell:*), Bash(curl:*), AskUserQuestion
---

Check whether Gemini is ready to use from Claude Code.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup "$ARGUMENTS"
```

The report names its backend: the Antigravity CLI (`agy`, the default) or the Gemini CLI (opt-in).

If the report says the Antigravity CLI is not installed:
- Use `AskUserQuestion` once, with the options `Install Antigravity CLI (Recommended)` and `Skip for now`.
- If the user chooses to install, run Google's official installer with the Bash tool and `timeout: 600000`, then run the setup command again:
  - Windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"`
  - macOS and Linux: `curl -fsSL https://antigravity.google/cli/install.sh | bash`

If the report is for the Gemini CLI and says it is not installed, or is too old, and npm is available:
- Use `AskUserQuestion` once, with the options `Install Gemini CLI (Recommended)` (or `Update Gemini CLI (Recommended)` when it is too old) and `Skip for now`.
- If the user chooses to install or update, run `npm install -g @google/gemini-cli` with the Bash tool and `timeout: 600000`, then run the setup command again.

Output rules:
- Present the final setup report as returned.
- If Gemini is installed but not signed in, keep the sign-in guidance. The user signs in in their own terminal: for the Antigravity CLI by running `agy`, signing in with Google in the browser and typing `/exit`; for the Gemini CLI with an API key in `~/.gemini/.env`, Vertex AI or a Gemini Code Assist account. Never ask the user to paste an API key, token or password into this chat, and never try to complete the sign-in yourself.
- If `--check` was not passed and everything else looks ready, mention that `/gemini:setup --check` confirms it with a live request.
