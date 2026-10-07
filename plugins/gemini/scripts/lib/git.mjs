// Git helpers: choose the review target and collect the diff that travels
// inside Gemini's prompt. Headless Gemini has no shell access, so it cannot
// run git itself; it can still open files with its read-only tools.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { runCommand } from "./proc.mjs";

export const DEFAULT_MAX_INLINE_BYTES = 600 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 192 * 1024;
const MIN_FILE_SHARE_BYTES = 4 * 1024;
// --ignore-submodules=dirty on every diff and status: see gitEnv. As a flag
// it wins over a submodule's own "ignore" setting in .gitmodules.
const NO_SUBMODULE_WORKTREES = "--ignore-submodules=dirty";
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "--submodule=diff", "--find-renames", NO_SUBMODULE_WORKTREES];
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

// Commands git could run while the plugin collects a review, before anyone
// has seen the change: core.fsmonitor, and the clean filters a repository's
// .gitattributes selects. Their commands can be, or call, files Gemini may
// have edited (Git LFS too runs configured extension commands), so the
// plugin's own git calls switch every filter off. Diffs of LFS-tracked files
// then compare the pointer with the raw content. A driver name may contain
// "=", which -c would split on, so the overrides travel in quoted 'key'='value'
// pairs (see gitEnv). Names are read NUL-separated.
const filterSettings = new Map();
export function gitFilterOverrides(cwd) {
  const key = path.resolve(cwd);
  if (!filterSettings.has(key)) {
    const listed = runCommand("git", ["-c", "core.fsmonitor=false", "config", "-z", "--name-only", "--get-regexp", "^filter\\."], { cwd });
    const drivers = new Set();
    for (const name of listed.status === 0 ? listed.stdout.split("\0") : []) {
      const match = /^filter\.([\s\S]+)\.[a-z]+$/i.exec(name);
      if (match) {
        drivers.add(match[1]);
      }
    }
    filterSettings.set(
      key,
      [...drivers].flatMap((driver) => [
        [`filter.${driver}.clean`, ""],
        [`filter.${driver}.process`, ""],
        [`filter.${driver}.required`, "false"]
      ])
    );
  }
  return filterSettings.get(key);
}

// The environment for a git call: the caller's, plus the overrides above,
// appended to GIT_CONFIG_PARAMETERS. Git reads that variable after
// GIT_CONFIG_COUNT entries and the last value wins, so the overrides win over
// settings a parent git passes down (tested), which are kept, as they may
// carry needed ones such as safe.directory. Submodule working trees
// are not inspected (here as a default, and as --ignore-submodules=dirty on
// each diff and status): git does that in a child process that reads the
// submodule's own filters, which these overrides cannot name. Their commits
// still show.
function gitEnv(cwd) {
  const settings = [["core.fsmonitor", "false"], ["diff.ignoreSubmodules", "dirty"], ...gitFilterOverrides(cwd)];
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  const own = settings.map(([name, value]) => `${quote(name)}=${quote(value)}`);
  const inherited = process.env.GIT_CONFIG_PARAMETERS?.trim();
  return { ...process.env, GIT_CONFIG_PARAMETERS: [...(inherited ? [inherited] : []), ...own].join(" ") };
}

function git(cwd, args) {
  return runCommand("git", ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false", ...args], { cwd, env: gitEnv(cwd) });
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

export function getRepoRoot(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.error || result.status !== 0) {
    return null;
  }
  const root = result.stdout.trim();
  return root ? path.resolve(root) : null;
}

// Git reads the quoted 'key'='value' pairs gitEnv passes from 2.31 on; older
// git stops every call with "unable to parse command-line config". Returns
// null when the version cannot be read.
export function isSupportedGitVersion(version) {
  const match = /(\d+)\.(\d+)/.exec(String(version ?? ""));
  if (!match) {
    return null;
  }
  const [major, minor] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && minor >= 31);
}

export function requireRepoRoot(cwd) {
  // Without gitEnv, which older git cannot parse.
  const probe = runCommand("git", ["--version"], { cwd });
  if (probe.error) {
    throw new Error("git is not installed or not on PATH.");
  }
  if (isSupportedGitVersion(probe.stdout) === false) {
    throw new Error(`Gemini reviews need git 2.31 or later; found ${probe.stdout.trim()}. Update git and try again.`);
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

// NUL-separated output keeps unusual file names exact: git quotes names with
// tabs, quotes or backslashes in its line output.
function pathList(text) {
  return text.split("\0").filter(Boolean);
}

export function getWorkingTreeState(cwd) {
  const staged = pathList(gitChecked(cwd, ["diff", "--cached", "--name-only", "-z", NO_SUBMODULE_WORKTREES]));
  const unstaged = pathList(gitChecked(cwd, ["diff", "--name-only", "-z", NO_SUBMODULE_WORKTREES]));
  const untracked = pathList(gitChecked(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]));
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

// True when a path really lies inside the repository. git lists the files
// inside an untracked link to a folder (a junction on Windows) as untracked
// files, and reading an untracked link to a file reads its target, so both
// are checked by where they really lead: nothing from outside the repository
// goes into the prompt.
// True when a path is, or leads through a link to, a Windows network path
// (\\server\share). Resolving one makes Windows contact that server, so links
// are read, not followed, until it is clear none leads there.
function leadsToNetwork(file, depth = 0) {
  if (process.platform !== "win32") {
    return false;
  }
  const value = String(file).replace(/\//g, "\\");
  if ((value.startsWith("\\\\") && !/^\\\\[?.]\\[a-z]:(\\|$)/i.test(value)) || depth > 16) {
    return true;
  }
  const resolved = path.resolve(file);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) {
      let target;
      try {
        target = fs.readlinkSync(current);
      } catch {
        return true;
      }
      return leadsToNetwork(path.resolve(path.dirname(current), target, ...parts.slice(index + 1)), depth + 1);
    }
  }
  return false;
}

function realPathInside(file, realRoot) {
  if (leadsToNetwork(file)) {
    return false;
  }
  let real;
  try {
    real = fs.realpathSync.native(file);
  } catch {
    return false;
  }
  const fold = (name) => (process.platform === "win32" ? name.toLowerCase() : name);
  const relative = path.relative(fold(realRoot), fold(real));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function formatUntracked(repoRoot, files, budget) {
  const blocks = [];
  const skipped = [];
  let used = 0;
  const realRoot = fs.realpathSync.native(repoRoot);

  for (const relative of files) {
    const absolute = path.join(repoRoot, relative);
    if (!realPathInside(absolute, realRoot)) {
      blocks.push(`### ${relative}\n(new file behind a link that leads out of the repository, not shown)`);
      continue;
    }
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

// Splits paths into those inside the repository and the links that lead out
// of it (a symlink, or a junction on Windows): git lists the target's files
// under an untracked link, and reads tracked files through a folder that was
// replaced by one. Only a link's own name goes into the prompt, never what
// lies behind it.
function splitByLinks(repoRoot, files, leadsOut = new Map()) {
  const realRoot = fs.realpathSync.native(repoRoot);
  const inside = [];
  const links = new Set();
  // "missing" (deleted, so nothing to read), "out" (a link that leads out,
  // or one whose target is gone) or "in".
  const where = (prefix) => {
    if (!leadsOut.has(prefix)) {
      const absolute = path.join(repoRoot, prefix);
      let exists = true;
      try {
        fs.lstatSync(absolute);
      } catch {
        exists = false;
      }
      leadsOut.set(prefix, !exists ? "missing" : realPathInside(absolute, realRoot) ? "in" : "out");
    }
    return leadsOut.get(prefix);
  };
  for (const relative of files) {
    const parts = relative.split("/");
    let link = null;
    for (let index = 1; index <= parts.length && !link; index += 1) {
      const prefix = parts.slice(0, index).join("/");
      const state = where(prefix);
      if (state === "missing") {
        break;
      }
      if (state === "out") {
        link = prefix;
      }
    }
    if (link) {
      links.add(link);
    } else {
      inside.push(relative);
    }
  }
  return { inside, links: [...links].sort() };
}

// git status, one entry per line, without the entries behind the links.
function statusText(repoRoot, links, untrackedLinks) {
  const behindLink = (file) => links.some((link) => file === link || file.startsWith(`${link}/`));
  const entries = pathList(gitChecked(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", NO_SUBMODULE_WORKTREES]));
  const lines = [];
  for (let index = 0; index < entries.length; index += 1) {
    const code = entries[index].slice(0, 2);
    const file = entries[index].slice(3);
    // A rename or copy is followed by the path it came from.
    const from = /[RC]/.test(code) ? entries[(index += 1)] : null;
    if (!behindLink(file) && !(from && behindLink(from))) {
      lines.push(from ? `${code} ${from} -> ${file}` : `${code} ${file}`);
    }
  }
  for (const link of links) {
    lines.push(`${untrackedLinks.includes(link) ? "??" : " M"} ${link} (a link that leads out of the repository)`);
  }
  return lines.join("\n");
}

function collectWorkingTree(repoRoot, budget) {
  const state = getWorkingTreeState(repoRoot);
  const leadsOut = new Map();
  const untrackedSplit = splitByLinks(repoRoot, state.untracked, leadsOut);
  const unstagedSplit = splitByLinks(repoRoot, state.unstaged, leadsOut);
  const untrackedFiles = untrackedSplit.inside;
  const links = [...new Set([...untrackedSplit.links, ...unstagedSplit.links])].sort();
  const changedFiles = [...new Set([...state.staged, ...unstagedSplit.inside, ...untrackedFiles, ...links])].sort();
  if (changedFiles.length === 0) {
    return { empty: true, changedFiles, summary: "the working tree is clean", content: "", truncatedFiles: [], lockfiles: [] };
  }

  const status = statusText(repoRoot, links, untrackedSplit.links);
  const untracked = formatUntracked(repoRoot, untrackedFiles, Math.min(MAX_UNTRACKED_TOTAL_BYTES, Math.floor(budget / 3)));
  // With only excluding pathspecs, git diffs everything else.
  const excluded = unstagedSplit.links.length ? ["--", ...unstagedSplit.links.map((link) => `:(top,exclude,literal)${link}`)] : [];
  const packed = packDiffSections(
    [gitChecked(repoRoot, ["diff", "--cached", ...DIFF_FLAGS]), gitChecked(repoRoot, ["diff", ...DIFF_FLAGS, ...excluded])],
    Math.max(budget - untracked.size, Math.floor(budget / 2))
  );

  return {
    empty: false,
    changedFiles,
    summary: `${state.staged.length} staged, ${unstagedSplit.inside.length + unstagedSplit.links.length} unstaged, ${untrackedFiles.length + untrackedSplit.links.length} untracked file(s)`,
    content: [
      section("Git status", status),
      section("Staged diff", packed.sections[0]),
      section("Unstaged diff", packed.sections[1]),
      section("Untracked files", untracked.text),
      ...(links.length
        ? [section("Links out of the repository", links.map((link) => `- ${link}: what lies behind this link is not shown`).join("\n"))]
        : [])
    ].join("\n"),
    truncatedFiles: [...packed.truncated, ...untracked.skipped],
    lockfiles: packed.lockfiles
  };
}

function collectBranch(repoRoot, baseRef, budget) {
  const mergeBase = gitChecked(repoRoot, ["merge-base", "HEAD", baseRef]).trim();
  const range = `${mergeBase}..HEAD`;
  const changedFiles = pathList(gitChecked(repoRoot, ["diff", "--name-only", "-z", range]));
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
