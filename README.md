# Gemini plugin for Claude Code

Use Google Gemini from inside Claude Code for code review, adversarial "challenge" review, sparring on designs and plans, and delegated investigations or fixes. The plugin drives the official [Gemini CLI](https://github.com/google-gemini/gemini-cli) in headless mode, so it uses your existing Gemini CLI sign-in (Google account, API key or Vertex AI). Claude Code needs no extra keys.

> Unofficial community plugin, not affiliated with or endorsed by Google or Anthropic. The command layout mirrors OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc), so the two can sit side by side.

## Commands

| Command | What it does |
| --- | --- |
| `/gemini:review` | Gemini reviews your uncommitted changes, or your branch against its base, and returns findings ordered by severity. Options: `--base <ref>`, `--scope auto\|working-tree\|branch`, `--model`, focus text. |
| `/gemini:adversarial-review` | A challenge review of the approach, design choices and assumptions, not just the lines. Same options. |
| `/gemini:ask` | An independent second opinion or sparring round on a question, plan or claim (read-only). `--resume` continues the last Gemini conversation, including a review, so you can push back on a finding. |
| `/gemini:rescue` | Hands an investigation or fix to Gemini through the `gemini-rescue` subagent. Read-only for diagnosis; `--write` lets Gemini edit files. `--background` for long jobs. |
| `/gemini:status`, `/gemini:result`, `/gemini:cancel` | Follow, read and stop background jobs. |
| `/gemini:setup` | Checks the Gemini CLI and sign-in; `--check` sends a live test request. |

Claude can also call the `gemini-rescue` subagent on its own when another model's view would help. Reviews only report findings; Claude asks before fixing anything.

## Requirements

- Claude Code with plugin support
- Node.js 20+ and npm
- Git (for reviews)
- The Gemini CLI 0.41 or newer: `npm install -g @google/gemini-cli` (`/gemini:setup` offers to install or update it)
- A Gemini sign-in, done once in a terminal: run `gemini` and choose **Sign in with Google** (free tier, or Google AI Pro/Ultra for higher limits). Alternatives: `GEMINI_API_KEY=<key>` from [Google AI Studio](https://aistudio.google.com/app/apikey) in `~/.gemini/.env`, or Vertex AI. Google Workspace accounts also need `GOOGLE_CLOUD_PROJECT`; see the [Gemini CLI authentication docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.md).
- A trusted folder: the Gemini CLI's folder trust is on by default, and headless runs stop in folders you have not trusted. Run `gemini` once in each repository and choose **Trust folder**, or set `GEMINI_CLI_TRUST_WORKSPACE=true` to trust every folder.

## Install

On any machine:

```bash
claude plugin marketplace add TheOmnilord/gemini-plugin-cc
claude plugin install gemini@gemini-cc
```

Or inside Claude Code: `/plugin marketplace add TheOmnilord/gemini-plugin-cc`, then `/plugin install gemini@gemini-cc`. Start a new session (or run `/reload-plugins`), then run `/gemini:setup --check`.

- Update: `claude plugin marketplace update gemini-cc`, then `claude plugin update gemini@gemini-cc`
- Remove: `claude plugin uninstall gemini@gemini-cc`

## How it works

- Every command calls [`plugins/gemini/scripts/gemini-companion.mjs`](plugins/gemini/scripts/gemini-companion.mjs), which runs `gemini --output-format stream-json` headlessly with the prompt on stdin.
- **Reviews** collect the git diff (staged, unstaged and untracked files, or the branch against its merge-base), inline it in the prompt, and ask Gemini for a JSON verdict with findings, which is rendered as Markdown. The diff budget defaults to 600 KB. Lockfile diffs are summarized, and oversized files are cut with a note telling Gemini to read them itself.
- **Safety:** reviews and asks run with `--approval-mode default`, so Gemini can only read. The companion also loads the plugin's policies at the highest user priority, so policy files inside a repository cannot loosen them:
  - [`no-shell.toml`](plugins/gemini/policies/no-shell.toml) blocks shell commands in every run.
  - [`no-edits.toml`](plugins/gemini/policies/no-edits.toml) blocks file edits in reviews, asks and read-only tasks.
  - [`review.toml`](plugins/gemini/policies/review.toml) switches off web search and fetch for reviews.

  Passing `--policy` makes the Gemini CLI skip `~/.gemini/policies`, so the companion passes that folder along too.
- **Write mode:** `--write` switches to `--approval-mode auto_edit`. Gemini may then edit files inside the repository, but it still cannot run shell commands. It also cannot change build files such as `package.json`, lockfiles, Makefiles or Dockerfiles, because the Gemini CLI never lets a headless run edit them. Gemini describes those changes instead.
- The Gemini CLI treats `@word` in a prompt as a file reference and pastes in any file that matches, so the companion escapes every `@` before sending and tells Gemini it has done so.
- Each run gets its own Gemini session ID. `--resume` continues that conversation with `gemini --resume <id>`.
- Job records and logs are stored per repository in Claude Code's plugin data folder (`~/.claude/plugins/data/gemini-gemini-cc/`).

## Configuration

| Environment variable | Effect |
| --- | --- |
| `GEMINI_COMPANION_MODEL` | Default model: `pro`, `flash`, `flash-lite`, `auto` or a full model id. Unset means the Gemini CLI default (auto routing). |
| `GEMINI_COMPANION_MAX_DIFF_KB` | Diff budget for reviews, in KB (default 600). |
| `GEMINI_COMPANION_CLI` | Path to a specific Gemini CLI entry script or executable. |
| `GEMINI_COMPANION_DATA` | Folder for job records and logs. |

Per-run flags: `--model <m>`, `--timeout-min <n>`, and for reviews `--max-diff-kb <n>`.

## Development

```bash
npm test
```

The tests run the companion against a fake Gemini CLI ([`tests/fixtures/fake-gemini.mjs`](tests/fixtures/fake-gemini.mjs)), so they need no sign-in. To try a working copy without installing it, start Claude Code with `claude --plugin-dir ./plugins/gemini`.

## License

MIT. See [LICENSE](LICENSE).
