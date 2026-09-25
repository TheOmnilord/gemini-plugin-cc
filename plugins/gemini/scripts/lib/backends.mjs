// The two ways the companion can reach Gemini, behind one interface.
//
// - agy (default): Google's Antigravity CLI. It serves personal Google
//   accounts, including the free plan and Google AI Pro and Ultra.
// - gemini-cli (opt in with GEMINI_COMPANION_BACKEND=gemini-cli): the Gemini
//   CLI, for Gemini API keys, Vertex AI and Gemini Code Assist Standard or
//   Enterprise. It stopped accepting personal Google sign-ins in June 2026.
//
// Handlers describe a run with backend-neutral fields: write (may edit files),
// web (may use web tools) and structured (the answer is a review object).

import { randomUUID } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  agyModelsUsed,
  agyTouchedFiles,
  agyUnavailableError,
  agyUsageSummary,
  classifyAgyFailure,
  isAgyRunSuccessful,
  resolveAgyLaunch,
  runAgy
} from "./agy.mjs";
import {
  classifyFailure,
  GeminiUnavailableError,
  geminiPolicyFiles,
  isRunSuccessful,
  modelsUsed,
  resolveGeminiLaunch,
  runGemini,
  touchedFiles,
  usageSummary
} from "./gemini.mjs";

export const BACKEND_NAMES = ["agy", "gemini-cli"];
const REVIEW_SCHEMA = fileURLToPath(new URL("../../schemas/review-output.schema.json", import.meta.url));

const agyBackend = {
  name: "agy",
  label: "Antigravity CLI",
  // agy reads @ and / literally, and its edits are limited by the plugin's guard only.
  prompt: { escapeAt: false, lockedBuildFiles: false },
  resolveLaunch: resolveAgyLaunch,
  unavailableError: agyUnavailableError,
  run(request) {
    return runAgy({ ...request, jsonSchemaFile: request.structured ? REVIEW_SCHEMA : null });
  },
  isRunSuccessful: isAgyRunSuccessful,
  classifyFailure: classifyAgyFailure,
  modelsUsed: agyModelsUsed,
  usageSummary: agyUsageSummary,
  touchedFiles: agyTouchedFiles
};

const geminiCliBackend = {
  name: "gemini-cli",
  label: "Gemini CLI",
  // The Gemini CLI treats @word as a file reference and never edits build files headless.
  prompt: { escapeAt: true, lockedBuildFiles: true },
  resolveLaunch: resolveGeminiLaunch,
  unavailableError: () => new GeminiUnavailableError(),
  run(request) {
    return runGemini({
      ...request,
      approvalMode: request.write ? "auto_edit" : "default",
      policyFiles: geminiPolicyFiles({ write: request.write, web: request.web }),
      sessionId: request.resumeSessionId ? null : randomUUID()
    });
  },
  isRunSuccessful,
  classifyFailure,
  modelsUsed,
  usageSummary,
  touchedFiles
};

export function backendName(value = process.env.GEMINI_COMPANION_BACKEND) {
  const name = String(value ?? "").trim().toLowerCase() || "agy";
  if (!BACKEND_NAMES.includes(name)) {
    throw new Error(`Unknown GEMINI_COMPANION_BACKEND "${value}". Use agy (the default) or gemini-cli.`);
  }
  return name;
}

export function getBackend(name = backendName()) {
  return name === "gemini-cli" ? geminiCliBackend : agyBackend;
}
