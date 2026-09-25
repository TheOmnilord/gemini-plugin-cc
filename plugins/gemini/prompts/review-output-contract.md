<output_contract>
Reply with one JSON object and nothing else: no Markdown fences, no text before or after it. Use this shape:
{
  "verdict": "approve" or "needs-attention",
  "summary": "two or three sentences: the ship or no-ship assessment and the main risk",
  "findings": [
    {
      "severity": "critical" or "high" or "medium" or "low",
      "title": "short statement of the problem",
      "body": "what goes wrong, under which inputs or conditions, and why this code path is affected",
      "file": "repository-relative path",
      "line_start": 1,
      "line_end": 1,
      "confidence": 0.0,
      "recommendation": "the concrete change that fixes the problem or reduces the risk"
    }
  ],
  "next_steps": ["short, concrete follow-ups such as tests to add or checks to run"]
}
Rules:
- Line numbers refer to the new version of the file.
- confidence is a number from 0 to 1.
- Use "needs-attention" when any finding should block shipping. Use "approve" with an empty findings array when nothing material is wrong.
- Order findings from most to least severe.
</output_contract>
