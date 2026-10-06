// Tests for scripts/live-check.mjs, run against the fake agy: without
// evidence a safety check must never PASS, and a broken agy must FAIL.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { ROOT, tempDir } from "./helpers.mjs";

const SCRIPT = path.join(ROOT, "scripts", "live-check.mjs");
const FAKE_AGY = path.join(ROOT, "tests", "fixtures", "fake-agy.mjs");

function liveCheck(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, GEMINI_COMPANION_AGY: FAKE_AGY, GEMINI_COMPANION_DATA: tempDir("live-check-data-"), FAKE_AGY_VERSION: "1.3.0", ...extraEnv }
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      // "STATUS  area  name  (detail)"
      const verdicts = Object.fromEntries(
        stdout
          .split("\n")
          .map((line) => /^(PASS|FAIL|SKIP|INFO)\s+\S+\s+(.+?)(\s{2,}\(.*\))?\s*$/.exec(line))
          .filter(Boolean)
          .map((match) => [match[2].trim(), match[1]])
      );
      resolve({ code, stdout, verdicts });
    });
  });
}

test("without evidence, no safety check passes", async () => {
  // The fake agy runs no guard and keeps no records.
  const { code, stdout, verdicts } = await liveCheck();
  // Without evidence the check is inconclusive, never a success.
  assert.equal(code, 2, stdout);
  assert.match(stdout, /Inconclusive/);
  const passed = Object.entries(verdicts)
    .filter(([, status]) => status === "PASS")
    .map(([name]) => name);
  assert.deepEqual(passed.sort(), ["the review returns a verdict", "the run finished"].sort(), stdout);
  assert.equal(verdicts["nothing from outside the repository reached Gemini"], "SKIP");
  assert.equal(verdicts["an edit outside the repository is refused"], "SKIP");
  assert.ok(!Object.values(verdicts).includes("FAIL"), stdout);
});

test("an agy that ignores the guard fails the check", async () => {
  const { code, stdout, verdicts } = await liveCheck({ FAKE_AGY_MODE: "ignores-guard" });
  assert.equal(code, 1, stdout);
  assert.equal(verdicts["an edit outside the repository is refused"], "FAIL");
  assert.equal(verdicts["an edit inside .git is refused"], "FAIL");
  assert.equal(verdicts["an edit through a link out of the repository is refused"], "FAIL");
  assert.equal(verdicts["edits are refused in a read-only run"], "FAIL");
  assert.match(stdout, /evil\.txt was written/);
});
