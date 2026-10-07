// Parses Gemini's review answer. agy enforces the JSON schema; the Gemini CLI
// cannot, so there the object is extracted leniently. Both are normalized.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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
        recommendation: text(finding.recommendation),
        assumptions: Array.isArray(finding.assumptions) ? finding.assumptions.map(text).filter(Boolean) : []
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

// Tools that read file contents in the repository, for agy and the Gemini
// CLI. Listing folders or finding files by name does not count: after a
// refused read it recovers nothing of what the review is about.
const READ_TOOLS = new Set(["view_file", "grep_search", "read_file", "read_many_files", "search_file_content"]);
const PATH_KEY = /(path|paths|file|files|directory|directories|dir|dirs)$/i;

function isRefused(call) {
  return call.status === "error" && REFUSAL.test(String(call.error ?? ""));
}

// Tools whose calls the run refused.
export function refusedTools(run) {
  const names = (run?.toolCalls ?? [])
    .filter(isRefused)
    .map((call) => call.name)
    .filter(Boolean);
  return [...new Set(names)];
}

// A path from a tool call, read the way the backends read it: relative to the
// repository, or a file:// URL. A "~" path is never counted: agy runs with its
// profile as the home folder, so there it names the profile, not the repository.
function insideRepo(value, repoRoot) {
  if (/^~(?=$|[\\/])/.test(value)) {
    return false;
  }
  let file = value;
  if (/^file:\/\//i.test(file)) {
    try {
      file = fileURLToPath(file);
    } catch {
      return false;
    }
  }
  // Compared by where they really lead, so a link in the repository to the notes does not count.
  const real = (name, base) => {
    try {
      return fs.realpathSync.native(path.resolve(base, name));
    } catch {
      return path.resolve(base, name);
    }
  };
  const root = real(repoRoot, ".");
  const fold = (name) => (process.platform === "win32" ? name.toLowerCase() : name);
  const relative = path.relative(fold(root), fold(real(file, root)));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathValues(value, key = "", out = []) {
  if (typeof value === "string") {
    if (PATH_KEY.test(key) && value.trim()) {
      out.push(value.trim());
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => pathValues(item, key, out));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([innerKey, item]) => pathValues(item, innerKey, out));
  }
  return out;
}

// True when Gemini read nothing in the repository after its last refused call:
// no successful read that it started once that refusal had come back. A review
// that comes back empty then may have stopped to report the refusal instead of
// reviewing. One that carried on (Gemini tried a file outside the repository,
// was refused, and went on reading the change) is not flagged. Notes, finish
// and reads already under way when the refusal arrived do not count.
export function stoppedAfterRefusal(run, repoRoot) {
  // Older records have no event counts; their order in the list stands in.
  const calls = (run?.toolCalls ?? []).map((call, index) => ({
    ...call,
    startedAt: call.startedAt ?? index * 2,
    endedAt: call.endedAt ?? index * 2 + 1
  }));
  const refusals = calls.filter(isRefused);
  if (!refusals.length) {
    return false;
  }
  const lastRefusal = Math.max(...refusals.map((call) => call.endedAt));
  return !calls.some(
    (call) =>
      call.status === "success" &&
      READ_TOOLS.has(call.name) &&
      call.startedAt > lastRefusal &&
      // A read that names no path searches the workspace: the Gemini CLI's
      // default. agy's guard refuses such reads, so they never succeed there.
      pathValues(call.parameters).every((value) => insideRepo(value, repoRoot))
  );
}

// agy returns schema-checked output separately; the Gemini CLI only has the text.
export function parseReview(answer, structured = null) {
  const value = structured && typeof structured === "object" && !Array.isArray(structured) ? structured : extractJsonObject(answer);
  return normalizeReview(value);
}
