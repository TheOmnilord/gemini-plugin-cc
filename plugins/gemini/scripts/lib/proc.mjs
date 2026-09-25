// Child-process helpers. Repository-derived arguments never pass through a
// shell; the only shell use is for fixed command lines such as npm's shim.

import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
    timeout: options.timeout,
    windowsHide: true,
    shell: false
  });
}

export function runShellLine(line, options = {}) {
  return spawnSync(line, {
    encoding: "utf8",
    windowsHide: true,
    shell: true,
    timeout: options.timeout ?? 20000
  });
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true
    });
    return result.status === 0;
  }
  // Gemini is spawned in its own process group on POSIX, so signal the group
  // first; fall back to the single process for anything else.
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGTERM");
      return true;
    } catch {
      // Not a group leader, or already gone.
    }
  }
  return false;
}
