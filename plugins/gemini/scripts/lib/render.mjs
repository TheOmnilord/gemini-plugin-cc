// Markdown rendering for everything the companion prints.

import { restoreAtSigns } from "./gemini.mjs";
import { ACTIVE_STATUSES } from "./jobs.mjs";

const AUTH_LABELS = {
  "oauth-personal": "Google account (Sign in with Google)",
  "gemini-api-key": "Gemini API key",
  "vertex-ai": "Vertex AI",
  "cloud-shell": "Cloud Shell",
  "compute-default-credentials": "Google Cloud default credentials"
};

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "?";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function formatAgo(iso) {
  const ms = Date.now() - Date.parse(iso ?? "");
  return Number.isFinite(ms) ? `${formatDuration(ms)} ago` : "";
}

function lastLines(text, count) {
  return String(text ?? "").trim().split(/\r?\n/).slice(-count).join("\n");
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function footer(job, extraLines = []) {
  const parts = [`job \`${job.id}\``];
  const models = job.modelsUsed?.length ? job.modelsUsed : job.model ? [job.model] : [];
  if (models.length) {
    parts.push(models.join(", "));
  }
  if (Number.isFinite(job.durationMs)) {
    parts.push(formatDuration(job.durationMs));
  }
  const usage = job.usage;
  if (usage && (usage.inputTokens != null || usage.outputTokens != null)) {
    parts.push(`${(usage.inputTokens ?? 0).toLocaleString("en-US")} in / ${(usage.outputTokens ?? 0).toLocaleString("en-US")} out tokens`);
  }
  return ["---", `Gemini · ${parts.join(" · ")}`, ...extraLines].join("\n");
}

function formatLocation(finding) {
  if (!finding.file) {
    return null;
  }
  if (!finding.lineStart) {
    return `\`${finding.file}\``;
  }
  const range = finding.lineEnd && finding.lineEnd !== finding.lineStart ? `${finding.lineStart}-${finding.lineEnd}` : `${finding.lineStart}`;
  return `\`${finding.file}:${range}\``;
}

export function renderReview({ label, context, focus, review, answer, job }) {
  const lines = [`# Gemini ${label}`, ""];
  const meta = [`**Target:** ${context.target.label} (${context.summary})`];
  if (focus) {
    meta.push(`**Focus:** ${focus}`);
  }
  if (review) {
    meta.push(`**Verdict:** ${review.verdict === "approve" ? "approve" : "needs attention"}`);
  }
  lines.push(meta.join("  \n"), "");
  if (context.truncatedFiles.length) {
    lines.push(`> The diff was cut to fit the prompt for ${context.truncatedFiles.length} file(s); Gemini was told to read those files directly.`, "");
  }

  if (!review) {
    lines.push("Gemini did not return the structured review format, so its answer is shown as-is:", "", restoreAtSigns(answer.trim()), "");
  } else {
    if (review.summary) {
      lines.push(restoreAtSigns(review.summary), "");
    }
    if (review.findings.length === 0) {
      lines.push("No material findings.", "");
    } else {
      lines.push("## Findings", "");
      review.findings.forEach((finding, index) => {
        lines.push(`### ${index + 1}. [${finding.severity}] ${restoreAtSigns(finding.title)}`);
        const details = [formatLocation(finding), finding.confidence != null ? `confidence ${finding.confidence.toFixed(2)}` : null].filter(Boolean);
        if (details.length) {
          lines.push(details.join(" · "));
        }
        lines.push("");
        if (finding.body) {
          lines.push(restoreAtSigns(finding.body), "");
        }
        if (finding.recommendation) {
          lines.push(`**Recommendation:** ${restoreAtSigns(finding.recommendation)}`, "");
        }
      });
    }
    if (review.nextSteps.length) {
      lines.push("## Next steps", "", ...review.nextSteps.map((step) => `- ${restoreAtSigns(step)}`), "");
    }
  }

  lines.push(footer(job, ["Push back or ask about a finding: `/gemini:ask --resume <message>`"]));
  return `${lines.join("\n")}\n`;
}

export function renderConsult({ job, answer, editedFiles }) {
  const heading = job.kind === "ask" ? "Gemini's answer" : job.write ? "Gemini task result (write mode)" : "Gemini task result";
  const lines = [`# ${heading}`, "", restoreAtSigns(answer.trim()), ""];
  if (job.write) {
    lines.push(
      editedFiles.length ? `**Files Gemini edited:**\n${editedFiles.map((file) => `- \`${file}\``).join("\n")}` : "Gemini did not edit any files.",
      ""
    );
  }
  lines.push(footer(job, ["Continue this conversation: `/gemini:ask --resume <message>` or `/gemini:rescue --resume <instruction>`"]));
  return `${lines.join("\n")}\n`;
}

export function renderFailure({ title, failure, run, job }) {
  const lines = [`# ${title} failed`, "", `**Reason:** ${failure.message}`];
  if (failure.hint) {
    lines.push(`**What to do:** ${failure.hint}`);
  }
  lines.push("");
  const excerpt = [run?.stderr, ...(run?.errors ?? []), run?.rawStdout].filter(Boolean).join("\n").trim();
  if (excerpt) {
    lines.push("Last lines from Gemini:", "```text", lastLines(excerpt, 15), "```", "");
  }
  if (run?.text?.trim()) {
    lines.push("Partial answer:", "", restoreAtSigns(run.text.trim()), "");
  }
  if (job?.logFile) {
    lines.push(`Log: \`${job.logFile}\``);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNothingToReview(label, context) {
  const hint =
    context.target.mode === "working-tree"
      ? "To review committed work instead, pass `--base <ref>` or `--scope branch`."
      : "To review uncommitted changes instead, use `--scope working-tree`.";
  return `Nothing for a Gemini ${label.toLowerCase()}: ${context.summary} (${context.target.label}). ${hint}\n`;
}

export function renderQueued(job) {
  return `${job.title} started in the background as \`${job.id}\`. Check \`/gemini:status ${job.id}\` for progress and \`/gemini:result ${job.id}\` when it finishes.\n`;
}

export function renderCancel(job) {
  return `Cancelled Gemini job \`${job.id}\` (${job.title}).\n`;
}

export function renderSetup(report) {
  const auth = report.auth;
  const lines = ["# Gemini setup", ""];
  lines.push(`- **Ready:** ${report.ready ? "yes" : "not yet"}`);
  lines.push(`- **Node.js:** ${report.node.version}${report.node.supported ? "" : " (the Gemini CLI needs Node.js 20 or newer)"}`);
  lines.push(`- **npm:** ${report.npm.available ? report.npm.version : "not found"}`);
  lines.push(`- **Gemini CLI:** ${report.gemini.installed ? `${report.gemini.version ?? "installed"} (${report.gemini.source})` : "not installed"}`);
  lines.push(`- **Sign-in:** ${auth.configured ? AUTH_LABELS[auth.method] ?? auth.method : "not configured"}`);
  if (report.live) {
    const live = report.live;
    lines.push(
      `- **Live check:** ${live.ok ? `passed in ${formatDuration(live.durationMs)}${live.models?.length ? ` (${live.models.join(", ")})` : ""}` : `failed: ${live.message}`}`
    );
  }
  if (report.defaultModel) {
    lines.push(`- **Default model:** ${report.defaultModel} (from GEMINI_COMPANION_MODEL)`);
  }
  lines.push(`- **Job data:** \`${report.dataDir}\``);
  for (const note of auth.notes ?? []) {
    lines.push(`- ${note}`);
  }
  if (report.nextSteps.length) {
    lines.push("", "## Next steps", "", ...report.nextSteps.map((step) => `- ${step}`));
  }
  if (report.live && !report.live.ok && report.live.excerpt) {
    lines.push("", "```text", report.live.excerpt, "```");
  }
  return `${lines.join("\n")}\n`;
}

function describeTiming(job) {
  if (ACTIVE_STATUSES.has(job.status)) {
    return job.startedAt ? `running ${formatDuration(Date.now() - Date.parse(job.startedAt))}` : "queued";
  }
  const took = Number.isFinite(job.durationMs) ? `took ${formatDuration(job.durationMs)}, ` : "";
  return `${took}${formatAgo(job.completedAt ?? job.updatedAt)}`;
}

export function renderStatus(jobs, { scoped, hiddenCount }) {
  if (!jobs.length) {
    const others = hiddenCount ? ` ${hiddenCount} job(s) from other Claude sessions: \`/gemini:status --all\`.` : "";
    return `No Gemini jobs${scoped ? " in this Claude session" : ""} for this repository yet.${others}\n`;
  }
  const lines = ["| Job | Kind | Status | Timing | Summary |", "|---|---|---|---|---|"];
  for (const job of jobs) {
    lines.push(`| \`${job.id}\` | ${job.kind} | ${job.status} | ${describeTiming(job)} | ${cell(job.resultSummary ?? job.summary)} |`);
  }
  lines.push("");
  const running = jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
  const finished = jobs.find((job) => !ACTIVE_STATUSES.has(job.status));
  if (running.length) {
    lines.push(`Running: ${running.map((job) => `\`${job.id}\``).join(", ")}. Details: \`/gemini:status <job-id>\`. Stop: \`/gemini:cancel <job-id>\`.`);
  }
  if (finished) {
    lines.push(`Latest result: \`/gemini:result ${finished.id}\``);
  }
  if (hiddenCount) {
    lines.push(`${hiddenCount} job(s) from other Claude sessions are hidden: \`/gemini:status --all\`.`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderJobDetail(job, logTail) {
  const rows = [
    ["Kind", job.kind],
    ["Status", job.status],
    ["Summary", job.resultSummary ?? job.summary],
    ["Timing", describeTiming(job)],
    ["Model", (job.modelsUsed?.length ? job.modelsUsed : [job.model]).filter(Boolean).join(", ")],
    ["Write mode", job.write ? "yes" : null],
    ["Gemini session", job.geminiSessionId],
    ["Error", job.errorMessage],
    ["Log", job.logFile ? `\`${job.logFile}\`` : null]
  ].filter(([, value]) => value);
  const lines = [`# Gemini job \`${job.id}\``, "", ...rows.map(([key, value]) => `- **${key}:** ${value}`)];
  if (logTail) {
    lines.push("", "Recent activity:", "```text", logTail, "```");
  }
  lines.push("", ACTIVE_STATUSES.has(job.status) ? `Stop it with \`/gemini:cancel ${job.id}\`.` : `Output: \`/gemini:result ${job.id}\``);
  return `${lines.join("\n")}\n`;
}
