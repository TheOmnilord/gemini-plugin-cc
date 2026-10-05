// Parses Gemini's review answer. agy enforces the JSON schema; the Gemini CLI
// cannot, so there the object is extracted leniently. Both are normalized.

const SEVERITIES = ["critical", "high", "medium", "low"];

export function extractJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  const attempts = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) {
    attempts.push(fenced[1].trim());
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    attempts.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of attempts) {
    // Gemini may copy the prompt's transport escape ("\@") into its JSON, where
    // it is not a valid escape; drop a lone backslash before an at-sign.
    const variants = candidate.includes("\\@") ? [candidate, candidate.replace(/(?<!\\)((?:\\\\)*)\\@/g, "$1@")] : [candidate];
    for (const variant of variants) {
      try {
        const value = JSON.parse(variant);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return value;
        }
      } catch {
        // Try the next candidate.
      }
    }
  }
  return null;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function normalizeReview(value) {
  if (!value || !Array.isArray(value.findings)) {
    return null;
  }
  const findings = value.findings
    .filter((finding) => finding && typeof finding === "object")
    .map((finding) => {
      const severity = SEVERITIES.includes(String(finding.severity).toLowerCase()) ? String(finding.severity).toLowerCase() : "medium";
      const lineStart = positiveInt(finding.line_start);
      const lineEnd = positiveInt(finding.line_end);
      const confidence = Number(finding.confidence);
      return {
        severity,
        title: text(finding.title) || "(untitled finding)",
        body: text(finding.body),
        file: text(finding.file),
        lineStart,
        lineEnd: lineEnd && lineStart && lineEnd >= lineStart ? lineEnd : lineStart,
        confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null,
        recommendation: text(finding.recommendation)
      };
    })
    .sort(
      (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (b.confidence ?? 0) - (a.confidence ?? 0)
    );

  const verdict = ["approve", "needs-attention"].includes(value.verdict)
    ? value.verdict
    : findings.some((finding) => finding.severity === "critical" || finding.severity === "high")
      ? "needs-attention"
      : "approve";

  return {
    verdict,
    summary: text(value.summary),
    findings,
    nextSteps: Array.isArray(value.next_steps) ? value.next_steps.map(text).filter(Boolean) : []
  };
}

// How each backend reports a tool call that it refused, as opposed to one that
// failed: agy's guard hook or permission check, the Gemini CLI's policy engine.
const REFUSAL = /denied by pre-tool hook|permission check failed|Tool execution denied by policy/i;

// Tools whose calls the run refused. A review that comes back empty after one
// may have stopped to report the refusal instead of reviewing.
export function refusedTools(run) {
  const names = (run?.toolCalls ?? [])
    .filter((call) => call.status === "error" && REFUSAL.test(String(call.error ?? "")))
    .map((call) => call.name)
    .filter(Boolean);
  return [...new Set(names)];
}

// agy returns schema-checked output separately; the Gemini CLI only has the text.
export function parseReview(answer, structured = null) {
  const value = structured && typeof structured === "object" && !Array.isArray(structured) ? structured : extractJsonObject(answer);
  return normalizeReview(value);
}
