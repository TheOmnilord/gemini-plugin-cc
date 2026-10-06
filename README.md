# Gemini plugin for Claude Code

Use Google Gemini from inside Claude Code for code review, adversarial "challenge" review, sparring on designs and plans, and delegated investigations or fixes. The plugin drives Google's [Antigravity CLI](https://antigravity.google/docs/cli/install) (`agy`) in headless mode, so it works with a personal Google account: the free plan, or Google AI Pro or Ultra for higher limits. Claude Code needs no extra keys.

Teams that use Gemini through a paid Gemini API key, Vertex AI or Gemini Code Assist Standard or Enterprise can switch the plugin to the [Gemini CLI](#gemini-cli-backend-opt-in) instead. Since June 18, 2026 the Gemini CLI no longer accepts personal Google sign-ins; Google's replacement for those accounts is the Antigravity CLI.

> Unofficial community plugin, not affiliated with or endorsed by Google or Anthropic. The command layout mirrors OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc), so the two can sit side by side.

## Commands

| Command | What it does |
| --- | --- |
| `/gemini:review` | Gemini reviews your uncommitted changes, or your branch against its base, and returns findings ordered by severity. Options: `--base <ref>`, `--scope auto\|working-tree\|branch`, `--model`, [web pages](#web-pages), focus text. |
| `/gemini:adversarial-review` | A challenge review of the approach, design choices and assumptions, not just the lines. Same options. |
| `/gemini:ask` | An independent second opinion or sparring round on a question, plan or claim (read-only). `--resume` continues the last Gemini conversation, including a review, so you can push back on a finding. |
| `/gemini:rescue` | Hands an investigation or fix to Gemini through the `gemini-rescue` subagent. Read-only for diagnosis; `--write` lets Gemini edit files. `--background` for long jobs. |
| `/gemini:status`, `/gemini:result`, `/gemini:cancel` | Follow, read and stop background jobs. |
| `/gemini:setup` | Checks the Antigravity CLI, the sign-in and the models your account offers; `--check` sends a live test request. |

Claude can also call the `gemini-rescue` subagent on its own when another model's view would help. Reviews only report findings; Claude asks before fixing anything.

## Requirements

- Claude Code with plugin support
- Node.js 20+ and Git
- The Antigravity CLI. `/gemini:setup` offers to install it, or run Google's installer yourself:
  - Windows (PowerShell): `irm https://antigravity.google/cli/install.ps1 | iex`
  - macOS and Linux: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
- A sign-in, done once: open a terminal, run `agy`, sign in with your Google account in the browser, then type `/exit`.

Tested on Windows. On macOS and Linux the plugin relies on `agy` keeping its sign-in in the system keyring; if `/gemini:setup` reports you as signed out although `agy` works, it shows a one-time command that signs in the plugin's own profile.

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

- Every command calls [`plugins/gemini/scripts/gemini-companion.mjs`](plugins/gemini/scripts/gemini-companion.mjs), which runs `agy -p "" --input-format stream-json --output-format stream-json` with the prompt on stdin and follows its event stream.
- **Reviews** collect the git diff (staged, unstaged and untracked files, or the branch against its merge-base), inline it in the prompt, and ask Gemini for a verdict with findings. `agy` enforces the [review schema](plugins/gemini/schemas/review-output.schema.json), and the result is rendered as Markdown. The diff budget defaults to 600 KB. Lockfile diffs are summarized, and oversized files are cut with a note telling Gemini to read them itself. An untracked link (a symlink or junction) that leads out of the repository is named, but neither its target's files nor their names are put in the prompt.
- **A private `agy` profile.** Plugin runs use their own `agy` profile in the plugin's data folder, so your own `agy` settings, rules and MCP servers never apply to them, and the plugin's rules never touch yours. The sign-in comes from the system keyring, so signing in to `agy` once covers both.
- **Safety.** Headless `agy` would approve file writes anywhere on disk, so the profile adds three layers:
  - The plugin's `gemini-cc` agent offers Gemini file reading and search, file edits and web tools, and no shell, browser or MCP tools.
  - The profile's settings deny shell commands, browser actions and MCP tools outright.
  - A guard hook ([`agy-guard.mjs`](plugins/gemini/scripts/agy-guard.mjs)) checks every tool call before it runs. Reads must stay inside the repository. Edits are allowed only in `--write` runs, only inside the repository and never inside a `.git`, `.agents` or `.gemini` folder, including those of nested repositories: files there (git hooks, and the agent settings `agy` and the Gemini CLI load from a repository, which can hold hooks and MCP servers) would run code on the next run. On Windows, network paths (`\\server\share`) are refused before they are resolved, also where a link leads to one, because resolving one makes Windows contact that server. Web search is off for reviews and on for asks and tasks. Web pages open only at the exact addresses a run lists with `--allow-url`. Anything else is denied.
  - Because the guard decides those, the profile lifts `agy`'s own checks on page reads and on file reads in the profile's `brain` folder, and keeps them for every other file outside the repository. Headless `agy` would otherwise refuse those reads and end the run, including when Gemini reads its own copy of a page it fetched. Outside the repository, the guard opens only the current conversation's folder in the profile, where `agy` keeps its notes and those copies; other conversations' transcripts stay closed. Symlinks and junctions are followed to where they really lead before a read or an edit is allowed. The guard sees only where a search starts; `agy`'s own searches do not follow links (checked on 1.2.17 and 1.3.0 with a junction out of the repository).
  - Since 1.3.0, `agy` also checks file edits itself and ends a headless run that needs one. `--write` runs therefore start `agy` with `--mode accept-edits`, which approves edits inside the repository and still refuses the rest, after the guard has checked them. Other runs do not get it.
- **Resume.** `--resume` continues the previous conversation with `agy --conversation <id>`. Each turn restates whether it may edit files, so a review can be followed by `/gemini:rescue --resume --write apply the top fix`.
- Job records and logs are stored per repository in Claude Code's plugin data folder (`~/.claude/plugins/data/gemini-gemini-cc/`), next to the `agy` profile.

### Web pages

Reviews run without web access, so Gemini judges a change from the diff and the repository. When a review should be checked against a page, such as a spec, an API reference or a page on a local dev server, name the page for that one run. Neither option is ever on by default: you ask for it, or Claude adds it when the review depends on a document you pointed to. Claude does not add addresses that only appear in the diff, the repository or Gemini's answers without asking you.

- `--context-url <url>` (reviews, up to 5): the companion fetches the page from your machine before the review starts and adds its text to the prompt, marked as untrusted. Gemini still has no web access, so nothing in the diff or the page can make it send data anywhere. Only http and https addresses are accepted, without a user name or password in them. Redirects are followed only on the same site, HTML is reduced to text and each page is capped at 200 KB. If a page cannot be fetched, the review stops instead of running without it.
- `--allow-url <url>` (reviews, asks and tasks, up to 5, Antigravity CLI only): Gemini may open exactly these addresses with its own URL tool, and the guard refuses every other address, including the same page with extra query parameters. `agy` fetches from your machine, so local addresses work. Use it when a page is too large to inline or Gemini should choose among several pages. `agy` follows a listed page's redirects without asking the guard, so list only sites you trust: an open redirect on a listed site could lead to another site, a local service or a cloud metadata address. Prefer `--context-url` when in doubt. The Gemini CLI cannot hold Gemini to exact addresses, so it rejects this flag.
`agy` also loads customizations from a repository's own `.agents/` folder (rules, skills, hooks and MCP servers), and unlike the Gemini CLI its headless runs do not ask whether you trust the folder. Gemini runs from Claude Code cannot edit that folder, but one already in the repository applies. Use the plugin on repositories you trust.

## Models

The default is `gemini-3.8-flash-medium`. Pass `--model` to a command or set `GEMINI_COMPANION_MODEL` to change it:

| Alias | Model |
| --- | --- |
| `flash`, `auto` | `gemini-3.8-flash-medium` |
| `flash-high`, `flash-low` | `gemini-3.8-flash-high`, `gemini-3.8-flash-low` |
| `flash-lite` | `gemini-3.8-flash-low` |
| `pro`, `pro-low` | `gemini-3.1-pro-high`, `gemini-3.1-pro-low` |

Any other model id from `agy models` works too; `/gemini:setup` lists the models your account offers.

## Gemini CLI backend (opt-in)

For a paid Gemini API key, Vertex AI or Gemini Code Assist Standard or Enterprise, the plugin can drive the [Gemini CLI](https://github.com/google-gemini/gemini-cli) instead. Set `GEMINI_COMPANION_BACKEND=gemini-cli` in the environment Claude Code runs in, for example in `~/.claude/settings.json`:

```json
{ "env": { "GEMINI_COMPANION_BACKEND": "gemini-cli" } }
```

Requirements:

- The Gemini CLI 0.41 or newer: `npm install -g @google/gemini-cli` (`/gemini:setup` offers to install or update it).
- A sign-in the Gemini CLI still accepts: `GEMINI_API_KEY=<key>` in `~/.gemini/.env`, Vertex AI, or a Gemini Code Assist Standard or Enterprise account. See the [Gemini CLI authentication docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.md).
- A trusted folder: the Gemini CLI's folder trust is on by default, and headless runs stop in folders you have not trusted. Run `gemini` once in each repository and choose **Trust folder**, or set `GEMINI_CLI_TRUST_WORKSPACE=true` to trust every folder.

How it differs:

- The companion runs `gemini --output-format stream-json` with the prompt on stdin. Reviews and asks use `--approval-mode default`, so Gemini can only read, and the companion loads the plugin's policies at the highest user priority, so policy files inside a repository cannot loosen them:
  - [`no-shell.toml`](plugins/gemini/policies/no-shell.toml) blocks shell commands in every run.
  - [`no-edits.toml`](plugins/gemini/policies/no-edits.toml) blocks file edits in reviews, asks and read-only tasks.
  - [`protected-folders.toml`](plugins/gemini/policies/protected-folders.toml) keeps `--write` runs out of `.git`, `.agents` and `.gemini` folders. It matches the path as written, so unlike `agy`'s guard it does not catch a link that leads into one of them.
  - [`review.toml`](plugins/gemini/policies/review.toml) switches off web search and fetch for reviews.

  Passing `--policy` makes the Gemini CLI skip `~/.gemini/policies`, so the companion passes that folder along too.
- `--write` switches to `--approval-mode auto_edit`. Gemini may then edit files inside the repository but not build files such as `package.json`, lockfiles, Makefiles or Dockerfiles, because the Gemini CLI never lets a headless run edit them.
- The Gemini CLI treats `@word` in a prompt as a file reference, so the companion escapes every `@` before sending and tells Gemini it has done so.
- Conversations are kept per backend: `--resume` never continues a conversation that the other backend started.

## Configuration

| Environment variable | Effect |
| --- | --- |
| `GEMINI_COMPANION_BACKEND` | `agy` (default) or `gemini-cli`. |
| `GEMINI_COMPANION_MODEL` | Default model, as an alias or a model id. With the Gemini CLI, unset means its own default (auto routing). |
| `GEMINI_COMPANION_MAX_DIFF_KB` | Diff budget for reviews, in KB (default 600). |
| `GEMINI_COMPANION_AGY` | Path to a specific `agy` executable. |
| `GEMINI_COMPANION_CLI` | Path to a specific Gemini CLI entry script or executable. |
| `GEMINI_COMPANION_DATA` | Folder for job records, logs and the plugin's `agy` profile. |

Per-run flags: `--model <m>`, `--timeout-min <n>`, `--allow-url <url>`, and for reviews `--max-diff-kb <n>` and `--context-url <url>`.

## Development

```bash
npm test
```

The tests run the companion against a fake `agy` ([`tests/fixtures/fake-agy.mjs`](tests/fixtures/fake-agy.mjs)) and a fake Gemini CLI ([`tests/fixtures/fake-gemini.mjs`](tests/fixtures/fake-gemini.mjs)), so they need no sign-in. GitHub Actions runs them on Windows, macOS and Linux for every pull request. To try a working copy without installing it, start Claude Code with `claude --plugin-dir ./plugins/gemini`.

```bash
npm run live-check
```

The fakes cannot notice when a new `agy` behaves differently, and `agy` updates itself. The live check runs four real Gemini jobs in scratch repositories against your signed-in `agy`. Each job is told to try things the guard must allow or refuse: reads outside the repository and through a link, edits inside and outside it and in `.git`, listed and unlisted web addresses, and a review. The check judges what actually happened, not what Gemini reports: the guard's decision for each exact call, the files on disk, a local web server's requests, and `agy`'s own record of each conversation with the raw tool results, where random tokens from outside the repository must never appear. It takes a few minutes and prints PASS, FAIL, SKIP (no evidence either way, for example because Gemini did not try that step) or INFO for each check. It exits with 0 only when every check passed, 1 when any failed and 2 when some were skipped (inconclusive: run it again). Run it after `agy` updates; `/gemini:setup` notes when `agy` is newer than the last version checked (`AGY_CHECKED_VERSION` in [`agy.mjs`](plugins/gemini/scripts/lib/agy.mjs)). `--companion <path>` checks another copy of the companion, such as the installed one, and `--keep` keeps the scratch folder.

## License

MIT. See [LICENSE](LICENSE).
