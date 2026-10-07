// Builds the prompts sent to Gemini from the templates in ../../prompts.
//
// Builders take the backend's prompt options: escapeAt (the Gemini CLI reads
// @word as a file reference, agy does not) and lockedBuildFiles (the Gemini
// CLI never lets a headless run edit build files).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { escapeAtSigns } from "./gemini.mjs";
import { allowUrlRule, referenceBlock, reviewWebRule, webAccessBlock } from "./reference.mjs";

const PROMPTS_DIR = path.resolve(fileURLToPath(new URL("../../prompts", import.meta.url)));

export const REVIEW_FINAL_INSTRUCTION =
  "Based on the repository context and instructions above, perform the review now and reply with only the JSON object described in the output contract.";
export const ASK_FINAL_INSTRUCTION =
  "Based on everything above, answer the request now, following the operating rules and the output format.";
export const TASK_FINAL_INSTRUCTION =
  "Based on everything above, carry out the request now, following the operating rules and the output format.";
export const FOLLOW_UP_FINAL_INSTRUCTION =
  "Respond to the follow-up above, building on our earlier exchange in this conversation.";

// Written without an at-sign so that escaping cannot garble the note itself.
const AT_SIGN_NOTE =
  "Transport note: every at-sign in this message is preceded by a backslash, because the Gemini CLI would otherwise treat it as a file reference. Ignore that backslash when you read code, e-mail addresses or package names: it is not part of the content and not a defect.";

const READ_ONLY_RULES = [
  "- Read-only session: your file-editing and shell tools are disabled. Do not attempt changes; when a change is warranted, describe it precisely (file, location, replacement code).",
  "- You can read and search files in the repository, and search the web when it genuinely helps."
].join("\n");

function writeRules(lockedBuildFiles) {
  return [
    "- You may create and edit files inside this repository with your file-editing tools. Shell commands are disabled, so you cannot build or run tests: list the exact commands Claude should run to verify your changes.",
    lockedBuildFiles
      ? "- Build and dependency files (package.json, lockfiles, Makefiles, Dockerfiles, go.mod, Cargo.toml, pyproject.toml and similar) cannot be edited in this session. If one needs a change, give the exact change for Claude to apply."
      : null,
    "- Keep edits narrowly scoped to the request: no unrelated refactors, renames or formatting churn."
  ]
    .filter(Boolean)
    .join("\n");
}

function load(name) {
  return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), "utf8");
}

function fill(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  );
}

// Escapes at-signs and adds the transport note only when the text needs it.
function assemble(templateName, values, { escapeAt = true } = {}) {
  const body = fill(load(templateName), values);
  const needsEscape = escapeAt && body.includes("@");
  const withNote = body.replace(/\{\{AT_SIGN_NOTE\}\}\r?\n\r?\n/, needsEscape ? `${AT_SIGN_NOTE}\n\n` : "");
  return `${(needsEscape ? escapeAtSigns(withNote) : withNote).trim()}\n`;
}

// web: { pages, allowUrls } named for this review with --context-url and --allow-url.
export function buildReviewPrompt(kind, context, focus, options = {}, web = {}) {
  const extra = [referenceBlock(web.pages ?? []), webAccessBlock(web.allowUrls ?? [])].filter(Boolean);
  const notes = [];
  if (context.truncatedFiles.length) {
    notes.push(`Note: the diff was cut to fit this prompt for these files; read them directly before judging them: ${context.truncatedFiles.join(", ")}`);
  }
  if (context.lockfiles.length) {
    notes.push(`Note: lockfile diffs are summarized, not shown: ${context.lockfiles.join(", ")}`);
  }
  if (context.skippedSubmodules?.length) {
    notes.push(
      `Note: uncommitted changes inside these submodules are not part of this review; do not judge or guess at them: ${context.skippedSubmodules.map(({ name }) => name).join(", ")}`
    );
  }
  return assemble(kind === "adversarial-review" ? "adversarial-review" : "review", {
    REPO_ROOT: context.repoRoot,
    BRANCH: context.branch,
    TARGET_LABEL: context.target.label,
    TARGET_SUMMARY: context.summary,
    CONTEXT_NOTES: notes.join("\n"),
    USER_FOCUS: focus || "No extra focus provided.",
    REVIEW_INPUT: context.content,
    EXTRA_CONTEXT: extra.map((block) => `${block}\n\n`).join(""),
    WEB_RULE: reviewWebRule(web),
    OUTPUT_CONTRACT: load("review-output-contract").trim()
  }, options);
}

function modeRules(write, allowUrls, options) {
  return [write ? writeRules(options.lockedBuildFiles ?? true) : READ_ONLY_RULES, allowUrlRule(allowUrls ?? [])].filter(Boolean).join("\n");
}

export function buildTaskPrompt({ request, write, kind, workspaceRoot, allowUrls }, options = {}) {
  return assemble(
    "task",
    {
      WORKSPACE: workspaceRoot,
      REQUEST_KIND: kind === "ask" ? "asked for your opinion on the request below" : "delegated the request below to you",
      REQUEST: request,
      MODE_RULES: modeRules(write, allowUrls, options),
      WRITE_OUTPUT_NOTE: write ? ', and a "Files changed" list with one line per file describing the change' : ""
    },
    options
  );
}

// A conversation can switch between read-only and write turns, so every
// follow-up restates the rules for its own turn.
export function buildFollowUpPrompt({ request, write, allowUrls }, options = {}) {
  return assemble(
    "follow-up",
    { REQUEST: request, MODE_RULES: modeRules(write, allowUrls, options) },
    options
  );
}
