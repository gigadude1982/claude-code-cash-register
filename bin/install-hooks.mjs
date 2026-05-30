#!/usr/bin/env node
// Install (or re-install) the cash-register hooks into a Claude profile.
//
//   node bin/install-hooks.mjs [configDir]
//
// configDir defaults to $CLAUDE_CONFIG_DIR or ~/.claude. Examples:
//   node bin/install-hooks.mjs ~/.claude-work
//   CLAUDE_CONFIG_DIR=~/.claude-work node bin/install-hooks.mjs
//
// It is idempotent and non-destructive:
//  - points statusLine at the forwarder, preserving any existing custom status
//    line via the REAL_STATUSLINE env var,
//  - adds the Notification + UserPromptSubmit hooks if not already present,
//  - backs up the original to settings.json.bak-cashreg.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HOME = homedir();
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
// Use ~ if the repo lives under $HOME so the config stays portable.
const repoRef = REPO.startsWith(HOME + "/") ? "~" + REPO.slice(HOME.length) : REPO;
const BIN = (name) => `${repoRef}/bin/${name}`;

const FORWARDER = BIN("statusline-forward.sh");
const HOOKS = {
  Notification: BIN("notify-alert.sh"),
  UserPromptSubmit: BIN("prompt-capture.sh"),
};

function expandTilde(p) {
  return p && p.startsWith("~/") ? join(HOME, p.slice(2)) : p;
}

// resolve the config dir
let cfgArg = process.argv[2] || process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
cfgArg = expandTilde(cfgArg);
const settingsPath = join(cfgArg, "settings.json");
if (!existsSync(cfgArg)) {
  console.error(`✗ config dir not found: ${cfgArg}`);
  process.exit(1);
}

let s = {};
if (existsSync(settingsPath)) {
  try {
    s = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (e) {
    console.error(`✗ ${settingsPath} is not valid JSON — aborting (${e.message})`);
    process.exit(1);
  }
  copyFileSync(settingsPath, settingsPath + ".bak-cashreg");
}

const changes = [];

// 1) statusLine → forwarder, preserving any existing custom status line.
const cur = s.statusLine?.command || "";
if (cur.includes("statusline-forward.sh")) {
  // already ours — leave as-is
} else {
  let command = FORWARDER;
  const realDefaults = ["", "~/.claude/statusline.sh", join(HOME, ".claude/statusline.sh")];
  if (cur && !realDefaults.includes(cur)) {
    // chain to the profile's own status line via env var
    command = `REAL_STATUSLINE='${cur}' ${FORWARDER}`;
  }
  s.statusLine = { type: "command", command, padding: s.statusLine?.padding ?? 2 };
  changes.push(`statusLine → ${command}`);
}

// 2) hooks (append our entry if absent)
s.hooks = s.hooks || {};
for (const [event, script] of Object.entries(HOOKS)) {
  const arr = (s.hooks[event] = s.hooks[event] || []);
  const present = JSON.stringify(arr).includes(script.split("/").pop());
  if (!present) {
    arr.push({ hooks: [{ type: "command", command: script }] });
    changes.push(`hooks.${event} → ${script}`);
  }
}

if (!changes.length) {
  console.log(`✓ ${settingsPath} already wired up — nothing to do.`);
  process.exit(0);
}

writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
console.log(`✓ updated ${settingsPath} (backup: settings.json.bak-cashreg)`);
for (const c of changes) console.log(`   + ${c}`);
