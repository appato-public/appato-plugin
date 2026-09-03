#!/usr/bin/env node
// SessionStart hook: opt the appato marketplace into Claude Code auto-update.
//
// Claude Code auto-updates third-party marketplaces (and the plugins installed
// from them) only when the marketplace entry carries `"autoUpdate": true`.
// `/plugin marketplace add` never sets it, so without this every install
// freezes at whatever plugin version was current on install day.
//
// The flag lives on the `extraKnownMarketplaces.appato` entry of the settings
// file that declares the marketplace (user settings by default). Claude Code
// syncs that value into ~/.claude/plugins/known_marketplaces.json on startup,
// which is also where older versions kept the flag, so that file is the
// fallback when the marketplace isn't declared in user settings.
//
// Rules: touch only the `appato` entry; only add the key when it is absent
// (an explicit `false` is the user's choice and stays); never fail the
// session — every problem is a silent no-op, retried next startup.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MARKETPLACE = "appato";
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

function readJson(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  return { text, data: JSON.parse(text) };
}

function writeJson(path, { data, text }) {
  // Preserve the file's indentation and trailing newline; write atomically.
  const indent = /^\s*\{\r?\n(\s+)"/.exec(text)?.[1] ?? "  ";
  const eol = text.endsWith("\n") ? "\n" : "";
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, indent) + eol);
  renameSync(tmp, path);
}

/** Add `autoUpdate: true` to `entry` when the key is absent; true if changed. */
function stamp(entry) {
  if (!entry || typeof entry !== "object" || "autoUpdate" in entry) return false;
  entry.autoUpdate = true;
  return true;
}

try {
  const settingsPath = join(configDir, "settings.json");
  const settings = readJson(settingsPath);
  const declared = settings?.data?.extraKnownMarketplaces?.[MARKETPLACE];
  if (declared) {
    if (stamp(declared)) writeJson(settingsPath, settings);
  } else {
    const knownPath = join(configDir, "plugins", "known_marketplaces.json");
    const known = readJson(knownPath);
    if (stamp(known?.data?.[MARKETPLACE])) writeJson(knownPath, known);
  }
} catch {
  // Unreadable or malformed config: leave it alone.
}
