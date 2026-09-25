---
name: gemini-prompting
description: Internal guidance for writing effective prompts and briefs for Gemini (Gemini 3 family) inside the Gemini Claude Code plugin
user-invocable: false
---

# Prompting Gemini

Use this when the `gemini:gemini-rescue` subagent or a `/gemini:ask` brief needs a better Gemini prompt.

Gemini 3 models do best with direct, well-structured prompts:
- Be precise and direct. State the goal, the scope and what "done" looks like in plain sentences. Skip persuasion and elaborate role-play.
- Use one consistent structure: XML-style tags (`<context>`, `<task>`, `<constraints>`, `<output_format>`) or Markdown headings, not a mix.
- Put long material (logs, excerpts, plans) first and the actual question or instruction last, anchored with "Based on the context above, ...".
- Name the files, symbols and error messages involved. Gemini can read the repository, so pointers beat pasted code.
- Say what output you want: sections, length, format. Gemini 3 defaults to concise answers; ask explicitly for depth when you need it.
- Ask for grounded claims: path:line citations, inferences labelled as such, open questions listed separately.
- For a second opinion, give the question and the facts, not your own conclusion, so the answer stays independent.
- In a resumed conversation, send only the new instruction or facts.
- One job per run. Split unrelated asks into separate runs.

Template:

```xml
<context>
Background, relevant files (path:line), constraints, what has been tried.
</context>
<task>
The concrete question or job, and what a good answer looks like.
</task>
<output_format>
For example: conclusion first, then evidence with path:line citations, then risks and next steps.
</output_format>
```
