// Job records for Gemini runs, kept per repository so /gemini:status,
// /gemini:result, /gemini:cancel and --resume work across turns and sessions.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isProcessAlive } from "./proc.mjs";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MAX_FINISHED_JOBS = 40;
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
export const ACTIVE_STATUSES = new Set(["queued", "running"]);

export function nowIso() {
  return new Date().toISOString();
}

export function dataRoot() {
  const override = process.env.GEMINI_COMPANION_DATA?.trim();
  if (override) {
    return path.resolve(override);
  }
  // Installed plugins run from <claude>/plugins/cache/<marketplace>/<plugin>/<version>,
  // and Claude Code keeps plugin data in <claude>/plugins/data/<plugin>-<marketplace>.
  const parts = PLUGIN_ROOT.split(/[\\/]+/);
  const cacheIndex = parts.lastIndexOf("cache");
  if (cacheIndex > 0 && parts[cacheIndex - 1] === "plugins" && parts.length >= cacheIndex + 3) {
    const pluginsDir = parts.slice(0, cacheIndex).join(path.sep) || path.sep;
    return path.join(pluginsDir, "data", `${parts[cacheIndex + 2]}-${parts[cacheIndex + 1]}`);
  }
  return path.join(os.tmpdir(), "gemini-companion");
}

export function workspaceStateDir(workspaceRoot) {
  let canonical = path.resolve(workspaceRoot);
  try {
    canonical = fs.realpathSync.native(canonical);
  } catch {
    // Keep the resolved path if it cannot be canonicalized.
  }
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const slug = path.basename(canonical).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return path.join(dataRoot(), "state", `${slug}-${hash}`);
}

function jobsDir(workspaceRoot) {
  return path.join(workspaceStateDir(workspaceRoot), "jobs");
}

export function jobFiles(workspaceRoot, id) {
  const dir = jobsDir(workspaceRoot);
  return {
    record: path.join(dir, `${id}.json`),
    log: path.join(dir, `${id}.log`),
    result: path.join(dir, `${id}.md`)
  };
}

function newJobId(kind) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${kind}-${stamp}-${randomBytes(2).toString("hex")}`;
}

export function saveJob(job) {
  const { record } = jobFiles(job.workspaceRoot, job.id);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  job.updatedAt = nowIso();
  const payload = `${JSON.stringify(job, null, 2)}\n`;
  const temporary = `${record}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, payload, "utf8");
    fs.renameSync(temporary, record);
  } catch {
    // Windows can refuse the rename while another process reads the file.
    fs.writeFileSync(record, payload, "utf8");
    fs.rmSync(temporary, { force: true });
  }
  return job;
}

export function createJob(fields) {
  const job = {
    id: newJobId(fields.kind),
    status: "queued",
    createdAt: nowIso(),
    claudeSessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null,
    ...fields
  };
  job.logFile = jobFiles(job.workspaceRoot, job.id).log;
  return saveJob(job);
}

export function loadJob(workspaceRoot, id) {
  try {
    return JSON.parse(fs.readFileSync(jobFiles(workspaceRoot, id).record, "utf8"));
  } catch {
    return null;
  }
}

// A job whose process vanished without recording a result is marked failed.
function reconcile(job) {
  if (!ACTIVE_STATUSES.has(job.status) || !job.pid) {
    return job;
  }
  const age = Date.now() - Date.parse(job.startedAt ?? job.createdAt ?? nowIso());
  if (!isProcessAlive(job.pid) || age > STALE_AFTER_MS) {
    job.status = "failed";
    job.errorMessage = job.errorMessage ?? "The Gemini job stopped without recording a result.";
    job.completedAt = job.completedAt ?? nowIso();
    saveJob(job);
  }
  return job;
}

export function listJobs(workspaceRoot) {
  let names;
  try {
    names = fs.readdirSync(jobsDir(workspaceRoot)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of names) {
    const job = loadJob(workspaceRoot, name.slice(0, -".json".length));
    if (job) {
      jobs.push(reconcile(job));
    }
  }
  return jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function pruneJobs(workspaceRoot) {
  const finished = listJobs(workspaceRoot).filter((job) => !ACTIVE_STATUSES.has(job.status));
  for (const job of finished.slice(MAX_FINISHED_JOBS)) {
    for (const file of Object.values(jobFiles(workspaceRoot, job.id))) {
      fs.rmSync(file, { force: true });
    }
  }
}

export function appendLog(logFile, message) {
  if (!logFile) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `[${nowIso()}] ${message}\n`, "utf8");
  } catch {
    // Logging must never break a run.
  }
}

export function readLogTail(logFile, lineCount) {
  try {
    return fs.readFileSync(logFile, "utf8").trimEnd().split(/\r?\n/).slice(-lineCount).join("\n");
  } catch {
    return "";
  }
}

export function findJob(workspaceRoot, reference, predicate = () => true) {
  const jobs = listJobs(workspaceRoot).filter(predicate);
  if (!reference) {
    return jobs[0] ?? null;
  }
  const exact = jobs.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }
  const matches = jobs.filter((job) => job.id.startsWith(reference) || job.id.endsWith(`-${reference}`));
  if (matches.length > 1) {
    throw new Error(`"${reference}" matches several jobs: ${matches.map((job) => job.id).join(", ")}.`);
  }
  return matches[0] ?? null;
}
