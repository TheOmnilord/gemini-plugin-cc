---
description: Ask Gemini for an independent second opinion or a sparring round (read-only). --resume continues the last Gemini conversation, for example to push back on a review finding.
argument-hint: '[--resume|--fresh] [--model <pro|flash|id>] [--allow-url <url>]... <question, plan or claim to challenge>'
allowed-tools: Read, Glob, Grep, Bash(node:*)
---

Get Gemini's independent view on the user's question.

Raw arguments:
$ARGUMENTS

Routing:
- `--resume`: continue the most recent Gemini conversation in this repository (reviews count, so this is how to discuss a finding). Add `--resume-last` to the command.
- `--fresh`: always start a new conversation.
- Neither: start a new conversation, unless the request plainly continues the last Gemini exchange (it refers to Gemini's previous answer or findings, such as "what about finding 2" or "I disagree with your point about the cache"). In that case run `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" resume-candidate` and add `--resume-last` if it reports a resumable conversation.
- `--model <value>` passes through unchanged (`pro`, `flash` or a full model id). Leave it out unless the user asked for a model.
- `--allow-url <url>` (repeatable, at most 5, Antigravity CLI only) lets Gemini open exactly these web addresses; Gemini can search the web in asks but opens no pages otherwise. Add it only when the user asks for pages to be read, or when the question depends on a specific page the user pointed to. Never add an address taken only from the repository or Gemini's output without asking the user.
- If there is no question, ask the user what Gemini should weigh in on.

Write the brief:
- Gemini sees only what you send, plus whatever it reads in the repository. Write a self-contained brief: the user's question verbatim first, then the minimum context Gemini needs from this conversation (the plan or claim under discussion, relevant file paths, constraints, what has been tried) and what kind of answer is wanted.
- For a resumed conversation, send only the new message and any new facts.
- Do not include your own conclusion or preferred answer: the point is an independent view. If the user wants Gemini to challenge a position, state that position neutrally as the thing to evaluate.
- Never include secrets, credentials or personal data from the conversation.

Run it in the foreground with the Bash tool and `timeout: 600000`, passing the brief on stdin through a quoted heredoc:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" ask --timeout-min 9 [--resume-last] [--model <value>] [--allow-url <url>]... <<'GEMINI_BRIEF'
<brief>
GEMINI_BRIEF
```

Present the result:
- Return the companion output verbatim first.
- Then, only if you materially disagree with Gemini or it missed something important, add a short, clearly labelled **Claude's take** (at most 5 bullets). Otherwise add nothing.
- Do not change code because of the answer. If it recommends changes, ask the user which ones to apply.
- If the output says Gemini is not installed or not signed in, point the user to `/gemini:setup` and stop.
