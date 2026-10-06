// Markdown rendering for everything the companion prints.

import { MIN_GEMINI_VERSION, restoreAtSigns } from "./gemini.mjs";
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
  const notes = (job.notices ?? []).flatMap((notice) => [`> **Note:** ${notice}`, ""]);
  return [...notes, "---", `Gemini · ${parts.join(" · ")}`, ...extraLines].join("\n");
}

// Only prompts for the Gemini CLI escape at-signs, so only its answers are restored.
function unescaper(job) {
  return (job?.backend ?? "gemini-cli") === "gemini-cli" ? restoreAtSigns : (text) => String(text ?? "");
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

export function renderReview({ label, context, focus, review, answer, job, pages = [], refused = [] }) {
  const show = unescaper(job);
  const lines = [`# Gemini ${label}`, ""];
  const meta = [`**Target:** ${context.target.label} (${context.summary})`];
  if (focus) {
    meta.push(`**Focus:** ${focus}`);
  }
  if (pages.length) {
    meta.push(`**Reference pages:** ${pages.map((page) => `${page.url}${page.truncated ? " (cut to fit)" : ""}`).join(", ")}`);
  }
  if (job?.allowUrls?.length) {
    meta.push(`**Gemini may open:** ${job.allowUrls.join(", ")}`);
  }
  // The companion passes refused tools only when the review is possibly incomplete.
  const incomplete = Boolean(review) && review.findings.length === 0 && refused.length > 0;
  if (review) {
    meta.push(`**Verdict:** ${review.verdict === "approve" ? "approve" : "needs attention"}${incomplete ? " (possibly incomplete)" : ""}`);
  }
  lines.push(meta.join("  \n"), "");
  if (context.truncatedFiles.length) {
    lines.push(`> The diff was cut to fit the prompt for ${context.truncatedFiles.length} file(s); Gemini was told to read those files directly.`, "");
  }

  if (!review) {
    lines.push("Gemini did not return the structured review format, so its answer is shown as-is:", "", show(answer.trim()), "");
  } else {
    if (review.summary) {
      lines.push(show(review.summary), "");
    }
    if (incomplete) {
      lines.push(
        `> **Possibly incomplete:** Gemini returned no findings and read nothing more in the repository after the run refused some of its tool calls (${refused.map((name) => `\`${name}\``).join(", ")}). It may have stopped to report the restriction instead of reviewing the change. Read the summary above before relying on this result, and rerun the review if it did not cover the change.`,
        ""
      );
    } else if (review.findings.length === 0) {
      lines.push("No material findings.", "");
    } else {
      lines.push("## Findings", "");
      review.findings.forEach((finding, index) => {
        lines.push(`### ${index + 1}. [${finding.severity}] ${show(finding.title)}`);
        const details = [formatLocation(finding), finding.confidence != null ? `confidence ${finding.confidence.toFixed(2)}` : null].filter(Boolean);
        if (details.length) {
          lines.push(details.join(" · "));
        }
        lines.push("");
        if (finding.body) {
          lines.push(show(finding.body), "");
        }
        if (finding.recommendation) {
          lines.push(`**Recommendation:** ${show(finding.recommendation)}`, "");
        }
      });
    }
    if (review.nextSteps.length) {
      lines.push("## Next steps", "", ...review.nextSteps.map((step) => `- ${show(step)}`), "");
    }
  }

  lines.push(footer(job, ["Push back or ask about a finding: `/gemini:ask --resume <message>`"]));
  return `${lines.join("\n")}\n`;
}

export function renderConsult({ job, answer, editedFiles }) {
  const heading = job.kind === "ask" ? "Gemini's answer" : job.write ? "Gemini task result (write mode)" : "Gemini task result";
  const lines = [`# ${heading}`, "", unescaper(job)(answer.trim()), ""];
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
    lines.push("Partial answer:", "", unescaper(job)(run.text.trim()), "");
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
  return report.backend === "agy" ? renderAgySetup(report) : renderGeminiCliSetup(report);
}

function liveCheckLine(live) {
  return `- **Live check:** ${
    live.ok ? `passed in ${formatDuration(live.durationMs)}${live.models?.length ? ` (${live.models.join(", ")})` : ""}` : `failed: ${live.message}`
  }`;
}

function setupTail(lines, report) {
  if (report.nextSteps.length) {
    lines.push("", "## Next steps", "", ...report.nextSteps.map((step) => `- ${step}`));
  }
  if (report.live && !report.live.ok && report.live.excerpt) {
    lines.push("", "```text", report.live.excerpt, "```");
  }
  return `${lines.join("\n")}\n`;
}

function renderAgySetup(report) {
  const lines = ["# Gemini setup", ""];
  lines.push(`- **Ready:** ${report.ready ? "yes" : "not yet"}`);
  lines.push("- **Backend:** Antigravity CLI (`agy`), which works with personal Google accounts");
  lines.push(`- **Antigravity CLI:** ${report.agy.installed ? `${report.agy.version ?? "installed"} (${report.agy.source})` : "not installed"}`);
  if (report.agy.newerThanChecked) {
    lines.push(
      `- **Note:** agy ${report.agy.version} is newer than ${report.agy.checkedVersion}, the last version this plugin was checked against. agy updates itself and has changed behavior before; if Gemini runs fail in new ways, look for a plugin update.`
    );
  }
  const signIn = report.signIn;
  const signInText = !signIn
    ? "not checked"
    : signIn.signedIn
      ? "signed in"
      : signIn.signedIn === false
        ? "not signed in"
        : `could not be checked (${signIn.message})`;
  lines.push(`- **Sign-in:** ${signInText}`);
  const { requested, resolved, available } = report.model;
  const origin = !requested ? " (default)" : requested !== resolved ? ` (from \`${requested}\`)` : "";
  lines.push(`- **Model:** \`${resolved}\`${origin}${available === false ? ", not offered to this account" : ""}`);
  if (report.models.length) {
    lines.push(`- **Models on this account:** ${report.models.map((model) => `\`${model}\``).join(", ")}`);
  }
  if (report.live) {
    lines.push(liveCheckLine(report.live));
  }
  lines.push(`- **Plugin's agy profile:** \`${report.profile}\``);
  lines.push(`- **Job data:** \`${report.dataDir}\``);
  return setupTail(lines, report);
}

function renderGeminiCliSetup(report) {
  const auth = report.auth;
  const lines = ["# Gemini setup", ""];
  lines.push(`- **Ready:** ${report.ready ? "yes" : "not yet"}`);
  lines.push("- **Backend:** Gemini CLI (selected with GEMINI_COMPANION_BACKEND=gemini-cli)");
  lines.push(`- **Node.js:** ${report.node.version}${report.node.supported ? "" : " (the Gemini CLI needs Node.js 20 or newer)"}`);
  lines.push(`- **npm:** ${report.npm.available ? report.npm.version : "not found"}`);
  const tooOld = report.gemini.supported === false ? `, too old: the plugin needs ${MIN_GEMINI_VERSION} or newer` : "";
  lines.push(
    `- **Gemini CLI:** ${report.gemini.installed ? `${report.gemini.version ?? "installed"} (${report.gemini.source}${tooOld})` : "not installed"}`
  );
  lines.push(`- **Sign-in:** ${auth.configured ? AUTH_LABELS[auth.method] ?? auth.method : "not configured"}`);
  if (report.live) {
    lines.push(liveCheckLine(report.live));
  }
  if (report.defaultModel) {
    lines.push(`- **Default model:** ${report.defaultModel} (from GEMINI_COMPANION_MODEL)`);
  }
  lines.push(`- **Job data:** \`${report.dataDir}\``);
  for (const note of auth.notes ?? []) {
    lines.push(`- ${note}`);
  }
  return setupTail(lines, report);
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
