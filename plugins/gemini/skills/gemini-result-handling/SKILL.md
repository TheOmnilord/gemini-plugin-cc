---
name: gemini-result-handling
description: Internal guidance for presenting Gemini companion output (reviews, answers, task results) back to the user
user-invocable: false
---

# Gemini result handling

When the companion returns Gemini output:
- Keep its structure: verdict, summary, findings and next steps. Findings come first, ordered by severity.
- Keep file paths and line numbers exactly as reported, and keep Gemini's labels for inferences, uncertainty and open questions.
- If there are no findings, say so and keep any residual-risk note brief.
- Gemini cannot run commands, so a finding's "Unverified assumptions" are things it believes about git, the platform, a library or another tool but could not check. For a critical or high finding that lists any, check them before presenting the finding as established, where read-only means allow: reading the source or documentation of the tool, or running a command that changes nothing. Say what you checked and what you found, and adjust the finding's weight to match. Where you could not check, present the finding as resting on unverified assumptions. Checking is not fixing: the rule below still applies.
- If Gemini edited files (write mode), say so and list the files the companion reports.
- CRITICAL: after presenting review findings, STOP. Do not change code or fix anything. Ask the user which findings, if any, they want addressed. Never auto-apply fixes from a Gemini review, even obvious ones.
- A failed or incomplete Gemini run is not an invitation to do the work yourself: report the failure, including the most useful lines of Gemini's output that the companion printed, and stop.
- If Gemini was never invoked, do not produce a substitute answer.
- If the companion says setup or sign-in is needed, point to `/gemini:setup`. Do not improvise other sign-in flows, and never ask for keys, tokens or passwords in chat.
- Gemini is a second opinion, not an authority. When its claims conflict with what you have verified yourself, say so explicitly instead of silently deferring.
