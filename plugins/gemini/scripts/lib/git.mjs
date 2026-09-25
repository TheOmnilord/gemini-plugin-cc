// Git helpers: choose the review target and collect the diff that travels
// inside Gemini's prompt. Headless Gemini has no shell access, so it cannot
// run git itself; it can still open files with its read-only tools.

import fs from "node:fs";
import path from "node:path";

import { runCommand } from "./proc.mjs";

export const DEFAULT_MAX_INLINE_BYTES = 600 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 192 * 1024;
const MIN_FILE_SHARE_BYTES = 4 * 1024;
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "--submodule=diff", "--find-renames"];
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "packages.lock.json",
  "flake.lock"
]);

function git(cwd, args) {
  return runCommand("git", ["-c", "core.quotepath=off", ...args], { cwd });
}

function gitChecked(cwd, args) {
  const result = git(cwd, args);
  if (result.error) {
    throw result.error.code === "ENOENT" ? new Error("git is not installed or not on PATH.") : result.error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
  return result.stdout;
}

function nonEmptyLines(text) {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "");
}

export function getRepoRoot(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.error || result.status !== 0) {
    return null;
  }
  const root = result.stdout.trim();
  return root ? path.resolve(root) : null;
}

export function requireRepoRoot(cwd) {
  const probe = git(cwd, ["--version"]);
  if (probe.error) {
    throw new Error("git is not installed or not on PATH.");
  }
  const root = getRepoRoot(cwd);
  if (!root) {
    throw new Error("Gemini reviews need a Git repository. Run this from inside one.");
  }
  return root;
}

export function detectDefaultBranch(cwd) {
  const hasLocalBranch = (name) => git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).status === 0;
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      const name = remoteHead.slice("refs/remotes/origin/".length);
      return hasLocalBranch(name) ? name : `origin/${name}`;
    }
  }
  for (const candidate of ["main", "master", "trunk"]) {
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]).status === 0) {
      return candidate;
    }
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]).status === 0) {
      return `origin/${candidate}`;
    }
  }
  throw new Error("Could not detect the default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  const result = git(cwd, ["branch", "--show-current"]);
  const name = result.status === 0 ? result.stdout.trim() : "";
  return name || "HEAD (detached)";
}

export function getWorkingTreeState(cwd) {
  const staged = nonEmptyLines(gitChecked(cwd, ["diff", "--cached", "--name-only"]));
  const unstaged = nonEmptyLines(gitChecked(cwd, ["diff", "--name-only"]));
  const untracked = nonEmptyLines(gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]));
  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length + unstaged.length + untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, { base, scope } = {}) {
  if (base) {
    return { mode: "branch", baseRef: base, label: `branch diff against ${base}` };
  }
  const requested = (scope ?? "auto").trim() || "auto";
  if (!["auto", "working-tree", "branch"].includes(requested)) {
    throw new Error(`Unsupported --scope "${requested}". Use auto, working-tree or branch, or pass --base <ref>.`);
  }
  if (requested === "working-tree" || (requested === "auto" && getWorkingTreeState(cwd).isDirty)) {
    return { mode: "working-tree", label: "working tree diff" };
  }
  const detected = detectDefaultBranch(cwd);
  return { mode: "branch", baseRef: detected, label: `branch diff against ${detected}` };
}

function section(title, body) {
  const text = body.replace(/\s+$/, "");
  return `## ${title}\n\n${text.trim() ? text : "(none)"}\n`;
}

function fenceFor(text) {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  return "`".repeat(longest + 1);
}

function splitDiffByFile(diffText) {
  if (!diffText.trim()) {
    return [];
  }
  return diffText
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => ({ chunk, file: diffChunkPath(chunk) }));
}

function diffChunkPath(chunk) {
  const target = /^\+\+\+ b\/(.+)$/m.exec(chunk);
  if (target) {
    return target[1].trim();
  }
  const header = /^diff --git a\/.+? b\/(.+)$/m.exec(chunk);
  return header ? header[1].trim() : "(unknown file)";
}

function summarizeLockfile(chunk) {
  let added = 0;
  let removed = 0;
  for (const line of chunk.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return `${chunk.split("\n", 1)[0]}\n(lockfile diff omitted: +${added}/-${removed} lines)\n`;
}

// Fits per-file diff chunks into a budget: small files stay whole, the largest
// are cut at a line boundary with a marker telling Gemini to read the file.
function packChunks(entries, budget) {
  const sizes = entries.map((entry) => entry.chunk.length);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= budget) {
    return { texts: entries.map((entry) => entry.chunk), truncated: [] };
  }

  const minimumShare = Math.min(MIN_FILE_SHARE_BYTES, Math.floor(budget / Math.max(1, entries.length)));
  const allowance = new Array(entries.length).fill(0);
  const bySize = entries.map((_, index) => index).sort((a, b) => sizes[a] - sizes[b]);
  let remaining = budget;
  bySize.forEach((entryIndex, position) => {
    const fairShare = Math.floor(remaining / (bySize.length - position));
    allowance[entryIndex] = Math.min(sizes[entryIndex], Math.max(fairShare, minimumShare));
    remaining = Math.max(0, remaining - allowance[entryIndex]);
  });

  const truncated = [];
  const texts = entries.map((entry, index) => {
    if (allowance[index] >= sizes[index]) {
      return entry.chunk;
    }
    truncated.push(entry.file);
    const cut = entry.chunk.slice(0, allowance[index]);
    const lastNewline = cut.lastIndexOf("\n");
    const kept = lastNewline > 0 ? cut.slice(0, lastNewline + 1) : cut;
    return `${kept}[... diff truncated here: ${kept.length} of ${sizes[index]} characters shown. Open ${entry.file} with your file-reading tool for the full picture ...]\n`;
  });
  return { texts, truncated };
}

function packDiffSections(sections, budget) {
  const entries = [];
  sections.forEach((text, sectionIndex) => {
    for (const entry of splitDiffByFile(text)) {
      const lockfile = LOCKFILES.has(path.posix.basename(entry.file));
      entries.push({
        file: entry.file,
        sectionIndex,
        lockfile,
        chunk: lockfile ? summarizeLockfile(entry.chunk) : entry.chunk
      });
    }
  });

  const { texts, truncated } = packChunks(entries, budget);
  const grouped = sections.map(() => []);
  entries.forEach((entry, index) => grouped[entry.sectionIndex].push(texts[index]));
  return {
    sections: grouped.map((parts) => parts.join("")),
    truncated: [...new Set(truncated)],
    lockfiles: [...new Set(entries.filter((entry) => entry.lockfile).map((entry) => entry.file))],
    size: texts.reduce((sum, text) => sum + text.length, 0)
  };
}

function formatUntracked(repoRoot, files, budget) {
  const blocks = [];
  const skipped = [];
  let used = 0;

  for (const relative of files) {
    const absolute = path.join(repoRoot, relative);
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      blocks.push(`### ${relative}\n(new file, unreadable)`);
      continue;
    }
    if (stat.isDirectory()) {
      blocks.push(`### ${relative}\n(new directory)`);
      continue;
    }
    if (LOCKFILES.has(path.basename(relative))) {
      blocks.push(`### ${relative}\n(new lockfile, ${stat.size} bytes, not shown)`);
      continue;
    }
    if (stat.size > MAX_UNTRACKED_FILE_BYTES || used + stat.size > budget) {
      skipped.push(relative);
      blocks.push(`### ${relative}\n(new file, ${stat.size} bytes, not inlined: open it with your file-reading tool)`);
      continue;
    }

    let buffer;
    try {
      buffer = fs.readFileSync(absolute);
    } catch {
      blocks.push(`### ${relative}\n(new file, unreadable)`);
      continue;
    }
    if (buffer.subarray(0, 8192).includes(0)) {
      blocks.push(`### ${relative}\n(new binary file, ${stat.size} bytes)`);
      continue;
    }

    const text = buffer.toString("utf8").replace(/\s+$/, "");
    const fence = fenceFor(text);
    used += text.length;
    blocks.push(`### ${relative} (new file)\n${fence}\n${text}\n${fence}`);
  }

  return { text: blocks.join("\n\n"), skipped, size: used };
}

function collectWorkingTree(repoRoot, budget) {
  const state = getWorkingTreeState(repoRoot);
  const changedFiles = [...new Set([...state.staged, ...state.unstaged, ...state.untracked])].sort();
  if (changedFiles.length === 0) {
    return { empty: true, changedFiles, summary: "the working tree is clean", content: "", truncatedFiles: [], lockfiles: [] };
  }

  const status = gitChecked(repoRoot, ["status", "--short", "--untracked-files=all"]);
  const untracked = formatUntracked(repoRoot, state.untracked, Math.min(MAX_UNTRACKED_TOTAL_BYTES, Math.floor(budget / 3)));
  const packed = packDiffSections(
    [gitChecked(repoRoot, ["diff", "--cached", ...DIFF_FLAGS]), gitChecked(repoRoot, ["diff", ...DIFF_FLAGS])],
    Math.max(budget - untracked.size, Math.floor(budget / 2))
  );

  return {
    empty: false,
    changedFiles,
    summary: `${state.staged.length} staged, ${state.unstaged.length} unstaged, ${state.untracked.length} untracked file(s)`,
    content: [
      section("Git status", status),
      section("Staged diff", packed.sections[0]),
      section("Unstaged diff", packed.sections[1]),
      section("Untracked files", untracked.text)
    ].join("\n"),
    truncatedFiles: [...packed.truncated, ...untracked.skipped],
    lockfiles: packed.lockfiles
  };
}

function collectBranch(repoRoot, baseRef, budget) {
  const mergeBase = gitChecked(repoRoot, ["merge-base", "HEAD", baseRef]).trim();
  const range = `${mergeBase}..HEAD`;
  const changedFiles = nonEmptyLines(gitChecked(repoRoot, ["diff", "--name-only", range]));
  if (changedFiles.length === 0) {
    return { empty: true, changedFiles, summary: `nothing on this branch differs from ${baseRef}`, content: "", truncatedFiles: [], lockfiles: [] };
  }

  const log = gitChecked(repoRoot, ["log", "--oneline", "--decorate", "--no-color", range]);
  const stat = gitChecked(repoRoot, ["diff", "--stat", "--no-color", range]);
  const packed = packDiffSections([gitChecked(repoRoot, ["diff", ...DIFF_FLAGS, range])], budget);

  return {
    empty: false,
    changedFiles,
    mergeBase,
    summary: `${changedFiles.length} file(s) changed since merge-base ${mergeBase.slice(0, 12)}`,
    content: [section("Commit log", log), section("Diff stat", stat), section("Branch diff", packed.sections[0])].join("\n"),
    truncatedFiles: packed.truncated,
    lockfiles: packed.lockfiles
  };
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = requireRepoRoot(cwd);
  const budget = Math.max(16 * 1024, Math.floor(options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES));
  const details =
    target.mode === "working-tree" ? collectWorkingTree(repoRoot, budget) : collectBranch(repoRoot, target.baseRef, budget);
  return { repoRoot, branch: getCurrentBranch(repoRoot), target, budget, ...details };
}
