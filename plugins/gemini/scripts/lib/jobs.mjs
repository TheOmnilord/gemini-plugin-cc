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
// A background worker records its pid when it starts the run, within a second or two.
const NEVER_STARTED_AFTER_MS = 2 * 60 * 1000;
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
    result: path.join(dir, `${id}.md`),
    // One-way markers, created atomically and never removed while the job is kept.
    started: path.join(dir, `${id}.started`),
    cancel: path.join(dir, `${id}.cancel`)
  };
}

function newJobId(kind) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${kind}-${stamp}-${randomBytes(2).toString("hex")}`;
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const RENAME_DEADLINE_MS = 1000;

// Windows refuses to rename over a file while another process has it open,
// which status polling and background workers do all the time. The readers
// let go within milliseconds, so the rename is retried: writing the record
// in place instead would let a reader see it empty or half-written.
function replaceFile(temporary, target) {
  const deadline = Date.now() + RENAME_DEADLINE_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temporary, target);
      return true;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || Date.now() >= deadline) {
        return false;
      }
      pause(Math.min(5 + attempt * 5, 50, Math.max(1, deadline - Date.now())));
    }
  }
}

export function saveJob(job) {
  const { record } = jobFiles(job.workspaceRoot, job.id);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  job.updatedAt = nowIso();
  const payload = `${JSON.stringify(job, null, 2)}\n`;
  const temporary = `${record}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, payload, "utf8");
  if (!replaceFile(temporary, record)) {
    // Last resort after a second of refusals.
    fs.writeFileSync(record, payload, "utf8");
    fs.rmSync(temporary, { force: true });
  }
  return job;
}

// Starting and cancelling a job happen in different processes. After a job is
// created, only the process running it writes its record; a cancel and a
// status check never do, so they cannot overwrite the pids or the result it
// publishes. What they need to say lives in marker files that are created
// atomically and never removed while the job is kept: <id>.started (only one
// process can claim a job) and <id>.cancel. Each side records its own fact
// before it checks the other's: a worker saves its pid, then looks for a
// cancel; a cancel creates its marker, then reads the pids. Whatever the
// interleaving, the worker sees the cancel or the cancel sees the pid. A
// requested cancel always wins in the status shown (see jobView). Nothing is
// ever held, so nothing can be left locked by a crash.

// Creates a marker file; false when it already exists.
function createMarker(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.closeSync(fs.openSync(file, "wx"));
    return true;
  } catch (error) {
    if (error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

export function cancelRequested(workspaceRoot, id) {
  return fs.existsSync(jobFiles(workspaceRoot, id).cancel);
}

function markCancelled(job) {
  Object.assign(job, { status: "cancelled", completedAt: job.completedAt ?? nowIso(), errorMessage: "Cancelled by user.", resultSummary: "Cancelled by user." });
  return saveJob(job);
}

// Claims the job for this process and records it as running. Returns false,
// without anything started, when another process claimed it first, a cancel
// was requested, or the job is no longer waiting: its saved record is gone
// (pruned after it finished), no longer queued, or past the start window,
// after which status already shows it as never started. The caller's copy
// may be stale, so the saved record decides.
export function startJob(job, fields = {}) {
  if (!createMarker(jobFiles(job.workspaceRoot, job.id).started)) {
    return false;
  }
  const saved = loadJob(job.workspaceRoot, job.id);
  if (saved?.status !== "queued") {
    return false;
  }
  if (!(Date.now() - Date.parse(saved.createdAt ?? "") <= NEVER_STARTED_AFTER_MS)) {
    // Recorded as status already shows it, so it can be pruned like any finished job.
    Object.assign(saved, { status: "failed", completedAt: nowIso(), errorMessage: "The Gemini job never started." });
    saveJob(saved);
    return false;
  }
  Object.assign(job, fields, { status: "running", pid: process.pid, startedAt: nowIso() });
  saveJob(job);
  if (cancelRequested(job.workspaceRoot, job.id)) {
    markCancelled(job);
    return false;
  }
  return true;
}

// Records the backend's pid. Returns false when a cancel was requested, so the
// caller stops the process it just started.
export function recordBackendPid(job, pid) {
  job.geminiPid = pid;
  saveJob(job);
  return !cancelRequested(job.workspaceRoot, job.id);
}

// Saves a finished job; a cancel requested meanwhile wins over the late result.
export function completeJob(job, status, fields = {}) {
  const cancelled = cancelRequested(job.workspaceRoot, job.id);
  Object.assign(job, fields, { status: cancelled ? "cancelled" : status, completedAt: nowIso() });
  return saveJob(job);
}

// Requests a cancel and returns the job as now shown, with the pids recorded
// so far for the caller to stop. cancelled is false when the job had already
// finished. The record itself is left to the process running the job.
export function cancelJob(workspaceRoot, id) {
  const before = loadJob(workspaceRoot, id);
  if (!before || !ACTIVE_STATUSES.has(jobView(before).status)) {
    return { job: before && jobView(before), cancelled: false };
  }
  createMarker(jobFiles(workspaceRoot, id).cancel);
  return { job: jobView(loadJob(workspaceRoot, id) ?? before), cancelled: true };
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

// A record that exists but cannot be read or parsed is retried briefly: it
// can be caught mid-write by the last-resort path in saveJob.
export function loadJob(workspaceRoot, id) {
  const { record } = jobFiles(workspaceRoot, id);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(record, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR" || attempt >= 10) {
        return null;
      }
      pause(10);
    }
  }
}

function vanished(job) {
  if (!ACTIVE_STATUSES.has(job.status)) {
    return false;
  }
  const age = Date.now() - Date.parse(job.startedAt ?? job.createdAt ?? nowIso());
  return job.pid ? !isProcessAlive(job.pid) || age > STALE_AFTER_MS : job.status === "queued" && age > NEVER_STARTED_AFTER_MS;
}

// The job as status, result and cancel show it, derived from its record and
// markers without writing anything. A requested cancel wins, also over a
// result saved after it. A job whose process vanished without recording a
// result shows as failed, and so does a background job whose worker never
// started.
export function jobView(job) {
  if (cancelRequested(job.workspaceRoot, job.id)) {
    return job.status === "cancelled"
      ? job
      : { ...job, status: "cancelled", completedAt: job.completedAt ?? job.updatedAt, errorMessage: "Cancelled by user.", resultSummary: "Cancelled by user." };
  }
  if (!vanished(job)) {
    return job;
  }
  return {
    ...job,
    status: "failed",
    completedAt: job.completedAt ?? job.updatedAt,
    errorMessage: job.errorMessage ?? (job.pid ? "The Gemini job stopped without recording a result." : "The Gemini job never started.")
  };
}

// The job records as saved, before jobView.
function records(workspaceRoot) {
  let names;
  try {
    names = fs.readdirSync(jobsDir(workspaceRoot)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names.map((name) => loadJob(workspaceRoot, name.slice(0, -".json".length))).filter(Boolean);
}

function newestFirst(a, b) {
  return String(b.createdAt).localeCompare(String(a.createdAt));
}

export function listJobs(workspaceRoot) {
  return records(workspaceRoot).map(jobView).sort(newestFirst);
}

// Whether a job can be pruned, judged by what no process can still change
// rather than by the clock (a worker can be paused for days on a sleeping
// laptop): it was finished by the process that ran it, or that process is
// gone. A job that never started is a candidate once it is shown as failed;
// pruneJobs then closes it for good before deleting it.
function prunable(job) {
  if (!ACTIVE_STATUSES.has(job.status)) {
    return true;
  }
  return job.pid ? !isProcessAlive(job.pid) : vanished(job);
}

// Keeps the newest finished jobs. A job that shows as cancelled but whose
// worker has not stopped yet keeps its record and markers, so a delayed
// worker still finds the cancel.
export function pruneJobs(workspaceRoot) {
  const finished = records(workspaceRoot).filter(prunable).sort(newestFirst);
  for (const job of finished.slice(MAX_FINISHED_JOBS)) {
    const files = jobFiles(workspaceRoot, job.id);
    const neverStarted = ACTIVE_STATUSES.has(job.status) && !job.pid;
    // Claiming the start marker, and keeping it, means a worker that turns up
    // later cannot start the job. If a worker claimed it first, it is kept.
    if (neverStarted && !createMarker(files.started)) {
      continue;
    }
    for (const [kind, file] of Object.entries(files)) {
      if (!(neverStarted && kind === "started")) {
        fs.rmSync(file, { force: true });
      }
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
