---
description: Show the stored output of a finished Gemini job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" result "$ARGUMENTS"`

Present the output above in full. Keep the verdict, findings, file paths, line numbers and follow-up commands exactly as reported. Do not fix anything it mentions: if it contains findings, ask the user which ones, if any, they want addressed.

If it is a review and a critical or high finding lists unverified assumptions, check them as the gemini-result-handling skill describes, then add a short section headed "Checking Gemini's assumptions" after the output, saying what you checked, what you found, and which assumptions stay unverified.
