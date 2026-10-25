// Tells /gemini:setup when a newer release of this plugin is on GitHub.
// Claude Code looks for plugin updates in its own copy of the marketplace,
// which it refreshes by itself only once the user turns on auto-update for
// it, so without this check nothing would say that a release is out.

import fs from "node:fs";
import process from "node:process";

import { fetchPage } from "./reference.mjs";

export const MARKETPLACE_NAME = "gemini-cc";
const MANIFEST = new URL("../../.claude-plugin/plugin.json", import.meta.url);
// The manifest on the main branch is what `/plugin marketplace update` installs.
// GEMINI_COMPANION_RELEASE_URL replaces it, for the tests.
const RELEASE_MANIFEST_URL = "https://raw.githubusercontent.com/TheOmnilord/gemini-plugin-cc/main/plugins/gemini/.claude-plugin/plugin.json";
const TIMEOUT_MS = 5000;

export function installedPluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? "").trim());
  return match ? match.slice(1).map(Number) : null;
}

export function isNewerVersion(candidate, current) {
  const parts = versionParts(candidate);
  const base = versionParts(current);
  if (!parts || !base) {
    return false;
  }
  const difference = parts.map((part, index) => part - base[index]).find((value) => value !== 0) ?? 0;
  return difference > 0;
}

// The installed version and the latest release. latest is null when the check
// is off (GEMINI_COMPANION_UPDATE_CHECK=off) or failed; error says why it failed.
export async function checkForRelease() {
  const installed = installedPluginVersion();
  if (/^(off|0|false)$/i.test(process.env.GEMINI_COMPANION_UPDATE_CHECK?.trim() ?? "")) {
    return { installed, latest: null, newer: false, checked: false, error: null };
  }
  try {
    const { text } = await fetchPage(process.env.GEMINI_COMPANION_RELEASE_URL || RELEASE_MANIFEST_URL, { timeoutMs: TIMEOUT_MS });
    const latest = JSON.parse(text).version;
    if (!versionParts(latest)) {
      throw new Error("the release has no version number");
    }
    return { installed, latest, newer: isNewerVersion(latest, installed), checked: true, error: null };
  } catch (error) {
    return { installed, latest: null, newer: false, checked: true, error: error.message };
  }
}

export function pluginUpdateStep(release) {
  return (
    `Update the Gemini plugin to ${release.latest}: in Claude Code, run \`/plugin marketplace update ${MARKETPLACE_NAME}\`, then \`/reload-plugins\`. ` +
    `To get new releases automatically, run \`/plugin\`, open **Marketplaces**, select \`${MARKETPLACE_NAME}\` and choose **Enable auto-update**.`
  );
}
