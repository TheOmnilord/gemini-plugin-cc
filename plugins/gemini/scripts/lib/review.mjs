// Parses Gemini's review answer. The CLI cannot enforce a JSON schema, so the
// object is extracted leniently and normalized before rendering.

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
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
    } catch {
      // Try the next candidate.
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

export function parseReview(answer) {
  return normalizeReview(extractJsonObject(answer));
}
