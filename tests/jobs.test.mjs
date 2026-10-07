// Tests for the job records that background runs, status and cancel share.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

import {
  cancelJob,
  cancelRequested,
  completeJob,
  createJob,
  jobFiles,
  listJobs,
  loadJob,
  pruneJobs,
  recordBackendPid,
  saveJob,
  startJob
} from "../plugins/gemini/scripts/lib/jobs.mjs";
import { ROOT, tempDir } from "./helpers.mjs";

const JOBS = pathToFileURL(path.join(ROOT, "plugins", "gemini", "scripts", "lib", "jobs.mjs")).href;

function newJob(fields = {}) {
  process.env.GEMINI_COMPANION_DATA = tempDir("gemini-cc-jobs-");
  return createJob({ kind: "task", workspaceRoot: tempDir("gemini-cc-jobs-ws-"), title: "test", ...fields });
}

function failWith(code) {
  return Object.assign(new Error(code), { code });
}

// Runs a script against jobs.mjs in its own process, as the companion's
// processes do. Each child is stopped after a minute at the latest, and the
// test stops the rest as soon as one fails.
function runNode(script, env, children) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env }, timeout: 60_000 });
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (status) => (status === 0 ? resolve(output) : reject(new Error(output || `exited with ${status}`))));
  });
}

test("a record saved by one process is never seen missing or half-written by another", async (t) => {
  const job = newJob();
  const children = [];
  t.after(() => children.forEach((child) => child.exitCode === null && child.kill()));
  const env = { GEMINI_COMPANION_DATA: process.env.GEMINI_COMPANION_DATA, JOB_WS: job.workspaceRoot, JOB_ID: job.id, SYNC: tempDir("gemini-cc-jobs-sync-") };
  const prelude = `import fs from "node:fs"; import path from "node:path"; const jobs = await import(${JSON.stringify(JOBS)});
    const file = (name) => path.join(process.env.SYNC, name);
    const latest = (name) => { try { return Number(fs.readFileSync(file(name), "utf8")); } catch { return -1; } };
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const wait = (ready, what) => { const until = Date.now() + 20000; while (!ready()) { if (Date.now() > until) throw new Error("timed out waiting for " + what); sleep(2); } };`;

  // Windows refuses to rename over a file that another process is reading;
  // the record used to be written in place then, and readers saw it torn.
  // The writer starts once both readers are reading and, every 25 saves,
  // waits until both have seen its latest one, so the reads demonstrably
  // overlap the writes; the readers keep reading until the writer is done.
  const writer = runNode(
    `${prelude}
     wait(() => latest("seen-0") >= 0 && latest("seen-1") >= 0, "the readers");
     const job = jobs.loadJob(process.env.JOB_WS, process.env.JOB_ID);
     for (let i = 1; i <= 100; i += 1) {
       job.counter = i; job.padding = "x".repeat(5000); jobs.saveJob(job);
       if (i % 25 === 0) wait(() => latest("seen-0") >= i && latest("seen-1") >= i, "the readers to see save " + i);
     }
     fs.writeFileSync(file("done"), "");`,
    env,
    children
  );
  const reader = (index) =>
    runNode(
      `${prelude}
       let missing = 0, highest = -1;
       const versions = new Set();
       const until = Date.now() + 45000;
       for (;;) {
         const finished = fs.existsSync(file("done"));
         const job = jobs.loadJob(process.env.JOB_WS, process.env.JOB_ID);
         if (!job) missing += 1;
         else if ((job.counter ?? 0) > highest) { highest = job.counter ?? 0; versions.add(highest); fs.writeFileSync(file("seen-${index}"), String(highest)); }
         if (finished) break;
         if (Date.now() > until) throw new Error("the writer never finished");
         sleep(2);
       }
       console.log(JSON.stringify({ missing, versions: versions.size }));`,
      env,
      children
    );
  const [, ...reports] = await Promise.all([writer, reader(0), reader(1)]);
  for (const report of reports.map((text) => JSON.parse(text))) {
    assert.equal(report.missing, 0);
    assert.ok(report.versions >= 5, `a reader saw only ${report.versions} versions`);
  }
  assert.equal(loadJob(job.workspaceRoot, job.id).counter, 100);
  assert.deepEqual(fs.readdirSync(path.dirname(jobFiles(job.workspaceRoot, job.id).record)).filter((name) => name.endsWith(".tmp")), []);
});

test("a refused rename is retried, and written in place only after a second", (t) => {
  const job = newJob();
  const { record } = jobFiles(job.workspaceRoot, job.id);
  const rename = fs.renameSync;
  let refusals = 2;
  t.mock.method(fs, "renameSync", (...args) => {
    if (refusals > 0) {
      refusals -= 1;
      throw failWith("EPERM");
    }
    return rename(...args);
  });
  const write = t.mock.method(fs, "writeFileSync");
  job.counter = 1;
  saveJob(job);
  assert.equal(fs.renameSync.mock.callCount(), 3);
  assert.ok(write.mock.calls.every((call) => call.arguments[0] !== record), "the record was written in place");
  assert.equal(loadJob(job.workspaceRoot, job.id).counter, 1);

  // A rename that keeps failing falls back to writing the record in place.
  fs.renameSync.mock.mockImplementation(() => {
    throw failWith("EPERM");
  });
  job.counter = 2;
  const started = Date.now();
  saveJob(job);
  const elapsed = Date.now() - started;
  // About a second of retries; the upper bound only guards against a hang, as a loaded machine is slow.
  assert.ok(elapsed >= 900 && elapsed < 15_000, `gave up after ${elapsed} ms`);
  assert.ok(write.mock.calls.some((call) => call.arguments[0] === record));
  assert.equal(loadJob(job.workspaceRoot, job.id).counter, 2);
});

test("an unreadable record is retried, a missing one is not", (t) => {
  const job = newJob();
  const read = fs.readFileSync;
  const answers = [failWith("EBUSY"), "", '{"half":'];
  t.mock.method(fs, "readFileSync", (...args) => {
    const next = answers.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? read(...args);
  });
  assert.equal(loadJob(job.workspaceRoot, job.id).id, job.id);
  assert.equal(fs.readFileSync.mock.callCount(), 4);

  fs.readFileSync.mock.resetCalls();
  assert.equal(loadJob(job.workspaceRoot, "task-missing"), null);
  assert.equal(fs.readFileSync.mock.callCount(), 1);
});

test("a cancel before the worker starts keeps the job from running", () => {
  const job = newJob();
  // The worker read the job while it was queued...
  const workerCopy = loadJob(job.workspaceRoot, job.id);
  // ...then the cancel landed before it recorded that it was running.
  assert.equal(cancelJob(job.workspaceRoot, job.id).cancelled, true);
  assert.equal(startJob(workerCopy), false);
  assert.equal(workerCopy.status, "cancelled");
  assert.equal(loadJob(job.workspaceRoot, job.id).status, "cancelled");
});

test("a cancel after the worker starts finds its pid, and later saves cannot hide it", () => {
  const job = newJob();
  assert.equal(startJob(job, { model: "flash" }), true);
  assert.equal(loadJob(job.workspaceRoot, job.id).status, "running");

  const { job: cancelledJob, cancelled } = cancelJob(job.workspaceRoot, job.id);
  assert.equal(cancelled, true);
  assert.equal(cancelledJob.pid, process.pid);
  assert.equal(cancelledJob.model, "flash");

  // The backend started just after the cancel: the caller is told to stop it.
  // Its save rewrites the record as running, but the job still shows cancelled.
  assert.equal(recordBackendPid(job, 12345), false);
  assert.equal(loadJob(job.workspaceRoot, job.id).status, "running");
  assert.equal(listJobs(job.workspaceRoot)[0].status, "cancelled");
  completeJob(job, "completed", { resultSummary: "late" });
  assert.equal(loadJob(job.workspaceRoot, job.id).status, "cancelled");
  assert.equal(cancelJob(job.workspaceRoot, job.id).cancelled, false);
});

test("a status check holding an old copy cannot erase the pids a cancel needs", () => {
  const job = newJob();
  // A status check read the job while it was queued...
  const snapshot = loadJob(job.workspaceRoot, job.id);
  // ...the worker then started and launched the backend...
  assert.equal(startJob(job), true);
  assert.equal(recordBackendPid(job, 4242), true);
  // ...and status checks only derive what they show; they never save.
  listJobs(job.workspaceRoot);
  assert.equal(snapshot.status, "queued");
  const { job: cancelledJob, cancelled } = cancelJob(job.workspaceRoot, job.id);
  assert.equal(cancelled, true);
  assert.equal(cancelledJob.pid, process.pid);
  assert.equal(cancelledJob.geminiPid, 4242);
});

test("a cancel accepted just before the result was saved still wins", () => {
  const job = newJob();
  startJob(job);
  // The worker checked for a cancel and found none...
  assert.equal(cancelRequested(job.workspaceRoot, job.id), false);
  // ...then the cancel was accepted...
  assert.equal(cancelJob(job.workspaceRoot, job.id).cancelled, true);
  // ...and the worker saved its result.
  job.status = "completed";
  saveJob(job);
  assert.equal(listJobs(job.workspaceRoot)[0].status, "cancelled");
  assert.equal(cancelJob(job.workspaceRoot, job.id).cancelled, false);
});

test("a cancelled job is kept until its worker has stopped, so a late worker still sees the cancel", () => {
  const job = newJob();
  // The worker read the queued job, then paused...
  const workerCopy = loadJob(job.workspaceRoot, job.id);
  assert.equal(cancelJob(job.workspaceRoot, job.id).cancelled, true);
  // ...while more than enough newer jobs finished to trigger pruning.
  for (let index = 0; index < 45; index += 1) {
    const other = createJob({ kind: "task", workspaceRoot: job.workspaceRoot, title: `other ${index}` });
    other.createdAt = new Date(Date.now() + 1000 + index).toISOString();
    completeJob(other, "completed");
  }
  pruneJobs(job.workspaceRoot);
  assert.equal(fs.existsSync(jobFiles(job.workspaceRoot, job.id).cancel), true);
  assert.equal(startJob(workerCopy), false);
  assert.equal(listJobs(job.workspaceRoot).length, 41);

  // Once the worker has stopped, the job is old enough to go.
  pruneJobs(job.workspaceRoot);
  assert.equal(fs.existsSync(jobFiles(job.workspaceRoot, job.id).record), false);
  assert.equal(fs.existsSync(jobFiles(job.workspaceRoot, job.id).cancel), false);
});

test("pruning never lets a worker paused for long start a cancelled job, nor removes a live one", () => {
  const job = newJob();
  const workerCopy = loadJob(job.workspaceRoot, job.id);
  assert.equal(cancelJob(job.workspaceRoot, job.id).cancelled, true);
  // The worker stays paused well past the point where the job shows as never started...
  const record = loadJob(job.workspaceRoot, job.id);
  record.createdAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  saveJob(record);
  // ...and a job running for longer than six hours is still alive.
  const live = createJob({ kind: "task", workspaceRoot: job.workspaceRoot, title: "long" });
  assert.equal(startJob(live), true);
  live.createdAt = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  live.startedAt = live.createdAt;
  saveJob(live);
  for (let index = 0; index < 45; index += 1) {
    completeJob(createJob({ kind: "task", workspaceRoot: job.workspaceRoot, title: `other ${index}` }), "completed");
  }
  pruneJobs(job.workspaceRoot);

  // The never-started job is gone, but its start marker stays, so the worker cannot start it.
  assert.equal(fs.existsSync(jobFiles(job.workspaceRoot, job.id).record), false);
  assert.equal(fs.existsSync(jobFiles(job.workspaceRoot, job.id).started), true);
  assert.equal(startJob(workerCopy), false);
  // The long-running job is shown as failed, but its record is kept while its process lives.
  assert.equal(fs.existsSync(jobFiles(job.workspaceRoot, live.id).record), true);
  assert.equal(listJobs(job.workspaceRoot).find((item) => item.id === live.id).status, "failed");
});

test("a job shown as never started cannot start late", () => {
  const job = newJob();
  // The worker stalled past the start window: status shows the job as failed...
  const record = loadJob(job.workspaceRoot, job.id);
  record.createdAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  saveJob(record);
  assert.equal(listJobs(job.workspaceRoot)[0].status, "failed");
  // ...so the worker, waking up with its old copy, does not start it, and
  // records it as failed so it can be pruned like any finished job.
  assert.equal(startJob(job), false);
  assert.equal(loadJob(job.workspaceRoot, job.id).status, "failed");
  for (let index = 0; index < 45; index += 1) {
    completeJob(createJob({ kind: "task", workspaceRoot: job.workspaceRoot, title: `other ${index}` }), "completed");
  }
  pruneJobs(job.workspaceRoot);
  assert.equal(loadJob(job.workspaceRoot, job.id), null);
});

test("a worker with a stale copy cannot start a job that was cancelled and pruned", () => {
  const job = newJob();
  const first = loadJob(job.workspaceRoot, job.id);
  const delayed = loadJob(job.workspaceRoot, job.id);
  assert.equal(cancelJob(job.workspaceRoot, job.id).cancelled, true);
  assert.equal(startJob(first), false);
  assert.equal(loadJob(job.workspaceRoot, job.id).status, "cancelled");
  for (let index = 0; index < 45; index += 1) {
    completeJob(createJob({ kind: "task", workspaceRoot: job.workspaceRoot, title: `other ${index}` }), "completed");
  }
  pruneJobs(job.workspaceRoot);
  assert.equal(fs.existsSync(jobFiles(job.workspaceRoot, job.id).record), false);
  // Its markers went with it, but the saved record decides: there is none.
  assert.equal(startJob(delayed), false);
  assert.equal(loadJob(job.workspaceRoot, job.id), null);
});

test("a live job stays running and cancellable within its own time limit", () => {
  const job = newJob();
  assert.equal(startJob(job, { timeoutMs: 10 * 60 * 60 * 1000 }), true);
  // Eight hours in, with a ten-hour limit: still this live process's job.
  job.startedAt = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  saveJob(job);
  assert.equal(listJobs(job.workspaceRoot)[0].status, "running");
  assert.equal(cancelJob(job.workspaceRoot, job.id).cancelled, true);
});

test("a job whose backend outlives its companion stays cancellable", () => {
  const job = newJob();
  assert.equal(startJob(job), true);
  // The companion is gone (a pid that has exited), the backend still runs.
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  job.pid = exited;
  job.geminiPid = process.pid;
  saveJob(job);
  assert.equal(listJobs(job.workspaceRoot)[0].status, "running");
  const { cancelled, job: shown } = cancelJob(job.workspaceRoot, job.id);
  assert.equal(cancelled, true);
  assert.equal(shown.geminiPid, process.pid);
});

test("only one process can start a job", () => {
  const job = newJob();
  const first = loadJob(job.workspaceRoot, job.id);
  const second = loadJob(job.workspaceRoot, job.id);
  assert.equal(startJob(first), true);
  assert.equal(startJob(second), false);
  assert.equal(loadJob(job.workspaceRoot, job.id).pid, process.pid);
});

test("a finished job cannot be cancelled", () => {
  const job = newJob();
  startJob(job);
  completeJob(job, "completed");
  const { job: current, cancelled } = cancelJob(job.workspaceRoot, job.id);
  assert.equal(cancelled, false);
  assert.equal(current.status, "completed");
  assert.equal(fs.existsSync(jobFiles(job.workspaceRoot, job.id).cancel), false);
});

test("a background job whose worker never started is marked failed", () => {
  const fresh = newJob();
  const old = createJob({ kind: "task", workspaceRoot: fresh.workspaceRoot, title: "old" });
  old.createdAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  saveJob(old);

  const jobs = Object.fromEntries(listJobs(fresh.workspaceRoot).map((job) => [job.id, job]));
  assert.equal(jobs[fresh.id].status, "queued");
  assert.equal(jobs[old.id].status, "failed");
  assert.match(jobs[old.id].errorMessage, /never started/);
});
