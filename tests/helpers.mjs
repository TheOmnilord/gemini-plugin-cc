// Shared helpers for the companion tests: throwaway repositories, a runner for
// the companion script, and readers for what the fake CLIs record.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const COMPANION = path.join(ROOT, "plugins", "gemini", "scripts", "gemini-companion.mjs");

const createdDirs = [];

export function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A just-killed background process may still hold a file on Windows.
    }
  }
});

export function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

export function makeRepo() {
  const dir = tempDir("gemini-cc-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(dir, "app.js"), "export function average(xs) {\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

export function companion(args, { cwd, env, input = "" }) {
  const result = spawnSync(process.execPath, [COMPANION, ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Like companion(), but leaves the event loop free, for tests that serve pages.
export function companionAsync(args, { cwd, env, input = "" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COMPANION, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

export function captures(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

export function argAfter(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

export function argsAfter(args, name) {
  return args.flatMap((arg, index) => (arg === name ? [args[index + 1]] : []));
}

export async function waitFor(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for condition.");
}
