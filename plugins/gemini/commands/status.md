---
description: Show running and recent Gemini jobs for this repository
argument-hint: '[job-id] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" status "$ARGUMENTS"`

Present the output above as returned: the job table (or the single job's details) and the follow-up commands it lists. Do not summarize it or add commentary.
