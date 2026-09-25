---
description: Show the stored output of a finished Gemini job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" result "$ARGUMENTS"`

Present the output above in full. Keep the verdict, findings, file paths, line numbers and follow-up commands exactly as reported. Do not fix anything it mentions: if it contains findings, ask the user which ones, if any, they want addressed.
