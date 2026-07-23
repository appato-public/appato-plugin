#!/usr/bin/env node
// appato CLI — a deliberately thin REST client. All real logic is server-side;
// this walks files, holds a token, and relays deploy results. Agents drive it
// (see the appato skill), so stdout messages are written for them too.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";

const VERSION = "0.1.0";
const DEFAULT_HOST = process.env.APPATO_HOST || "https://appato.com";
const CRED_DIR = join(homedir(), ".appato");
const CRED_FILE = join(CRED_DIR, "credentials.json");
const IGNORE = new Set(["node_modules", ".git", "dist", ".appato", "appato.json"]);
const MAX_FILE_BYTES = 512 * 1024;

const [, , command, ...args] = process.argv;

try {
  switch (command) {
    case "login": await login(); break;
    case "logout": logout(); break;
    case "whoami": await whoami(); break;
    case "create": await create(args); break;
    case "push": await push(args); break;
    case "history": await history(args.includes("--json")); break;
    case "status": await status(args.includes("--json")); break;
    case "logs": console.log("logs: not implemented yet — coming in a future release"); break;
    case "upgrade": upgrade(); break;
    case "--version": case "version": console.log(VERSION); break;
    default: usage(); process.exit(command ? 1 : 0);
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}

function usage() {
  console.log(`appato ${VERSION} — build & deploy internal utility apps

usage:
  appato login              authenticate this machine (opens browser)
  appato logout             remove stored credentials
  appato whoami             show the signed-in user and orgs
  appato create <slug> --title "..." --description "..."  [--org <slug>]
                            create an app (writes appato.json here)
  appato push -m "..." [--details "..."]
                            upload current directory and deploy; also syncs
                            title/description from appato.json
  appato history [--json]   list versions with their change summaries
  appato status [--json]    show deploy status, URL, and local drift
  appato logs               (soon) tail the app's logs
  appato upgrade            update the CLI to the latest version`);
}

// ---------------------------------------------------------------------------
// auth

async function login() {
  const host = DEFAULT_HOST;
  // better-auth device authorization flow
  const codeRes = await fetch(`${host}/api/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: "appato-cli" }),
  });
  if (!codeRes.ok) throw new Error(`device flow unavailable (${codeRes.status})`);
  const code = await codeRes.json();
  const verifyUrl = code.verification_uri_complete || code.verification_uri;
  console.log(`Open to approve this device:\n  ${verifyUrl}`);
  tryOpen(verifyUrl);

  const interval = (code.interval || 5) * 1000;
  const deadline = Date.now() + (code.expires_in || 1800) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const tokenRes = await fetch(`${host}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: "appato-cli",
      }),
    });
    if (tokenRes.ok) {
      const token = await tokenRes.json();
      // Device-flow session token, sent as Authorization: Bearer.
      // TODO: exchange for a long-lived API key once the server supports it.
      const cred = { host, bearer: token.access_token };
      mkdirSync(CRED_DIR, { recursive: true });
      writeFileSync(CRED_FILE, JSON.stringify(cred, null, 2), { mode: 0o600 });
      console.log("Logged in.");
      await whoami();
      return;
    }
    const body = await tokenRes.json().catch(() => ({}));
    if (body.error && body.error !== "authorization_pending" && body.error !== "slow_down") {
      throw new Error(`login failed: ${body.error}`);
    }
  }
  throw new Error("login timed out");
}

function logout() {
  writeFileSync(CRED_FILE, "{}");
  console.log("Logged out.");
}

function credentials() {
  if (!existsSync(CRED_FILE)) {
    throw new Error("not logged in — run: appato login");
  }
  const cred = JSON.parse(readFileSync(CRED_FILE, "utf8"));
  if (!cred.bearer) throw new Error("not logged in — run: appato login");
  return cred;
}

async function apiFetch(path, options = {}) {
  const cred = credentials();
  const headers = { "Content-Type": "application/json", ...options.headers };
  headers["Authorization"] = `Bearer ${cred.bearer}`;
  const res = await fetch(`${cred.host}${path}`, { ...options, headers });
  checkCliVersion(res);
  return res;
}

function checkCliVersion(res) {
  const min = res.headers.get("x-appato-cli-min");
  const latest = res.headers.get("x-appato-cli-latest");
  if (min && semverLt(VERSION, min)) {
    throw new Error(
      `this CLI (v${VERSION}) is too old (server requires v${min}). Run: appato upgrade — then retry the command.`,
    );
  }
  if (latest && semverLt(VERSION, latest)) {
    console.error(`⬆ appato v${latest} available (you have v${VERSION}) — run: appato upgrade`);
  }
}

function semverLt(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true;
    if ((pa[i] || 0) > (pb[i] || 0)) return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// commands

async function whoami() {
  const res = await apiFetch("/api/me");
  if (!res.ok) throw new Error(`unauthorized — run: appato login`);
  const me = await res.json();
  console.log(`${me.user.email} (orgs: ${me.orgs.map((o) => o.slug).join(", ") || "none"})`);
}

async function create(args) {
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-")) i++; // skip flag and its value
    else positionals.push(args[i]);
  }
  const slug = positionals[0];
  const title = flagValue(args, "--title");
  const description = flagValue(args, "--description");
  const org = flagValue(args, "--org");
  if (!slug || !title || !description) {
    throw new Error(
      'usage: appato create <slug> --title "Human Title" --description "One or two sentences: what the app does and who it\'s for" [--org <org>]',
    );
  }
  const res = await apiFetch("/api/apps", {
    method: "POST",
    body: JSON.stringify({ slug, org, title, description }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `create failed (${res.status})`);
  writeFileSync(
    join(process.cwd(), "appato.json"),
    JSON.stringify({ org: body.org, app: body.slug, title, description }, null, 2) + "\n",
  );
  console.log(`Created ${body.org}/${body.slug} — "${title}"`);
  console.log(`URL (after first push): ${body.url}`);
}

async function history(json = false) {
  const { org, app } = appConfig();
  const res = await apiFetch(`/api/apps/${org}/${app}/versions`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `history failed (${res.status})`);
  if (json) {
    console.log(JSON.stringify(body.versions));
    return;
  }
  for (const v of body.versions) {
    const flag = v.deployStatus === "deployed" ? "✓" : v.deployStatus === "error" ? "✗" : "·";
    console.log(`${flag} v${v.id}  ${ago(v.createdAt)} ago  ${v.message || "(no message)"}`);
    if (v.details) console.log(`     ${v.details.replace(/\n/g, "\n     ")}`);
  }
}

function appConfig() {
  const path = join(process.cwd(), "appato.json");
  if (!existsSync(path)) {
    throw new Error("no appato.json here — run: appato create <slug>");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

// The final APPATO_* line of push/status is a stable machine contract for
// driving agents (see SKILL.md): space-separated key=value pairs, values
// JSON-encoded when they may contain spaces. Don't reword these lines.
async function push(args = []) {
  const { org, app, title, description } = appConfig();
  const message = flagValue(args, "-m") ?? flagValue(args, "--message");
  const details = flagValue(args, "--details") ?? "";
  if (!message) {
    throw new Error(
      'a change summary is required: appato push -m "one-line, user-facing summary" [--details "a short paragraph: what changed for users, why, and any notable decisions"]',
    );
  }
  const files = collectFiles(process.cwd());
  if (Object.keys(files).length === 0) throw new Error("no files to push");
  const sha = filesSha(files);
  const res = await apiFetch(`/api/apps/${org}/${app}/push`, {
    method: "POST",
    // title/description come from appato.json — the manifest is the source
    // of truth for app metadata, synced on every push.
    body: JSON.stringify({ files, message, details, title, description }),
  });
  const body = await res.json();
  if (res.status === 422) {
    console.error(`✗ pushed v${body.version}, but deploy FAILED:\n  ${body.deployError}`);
    console.error("Fix the error above and push again.");
    console.log(`APPATO_DEPLOY_FAILED app=${org}/${app} version=${body.version} sha=${sha} error=${JSON.stringify(body.deployError ?? "unknown")}`);
    process.exit(2);
  }
  if (!res.ok) throw new Error(body.error || `push failed (${res.status})`);
  console.log(`✓ deployed v${body.version} → ${body.url}`);
  console.log(`APPATO_DEPLOYED app=${org}/${app} version=${body.version} sha=${sha} url=${body.url}`);
}

async function status(json = false) {
  const { org, app } = appConfig();
  const res = await apiFetch(`/api/apps/${org}/${app}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `status failed (${res.status})`);
  const local = collectFiles(process.cwd());
  const changedFiles = diffFiles(local, body.files ?? {});
  const out = {
    app: `${org}/${app}`,
    url: body.url,
    deployStatus: body.deployStatus,
    deployError: body.deployError ?? null,
    latestVersion: body.latestVersion,
    deployedVersion: body.deployedVersion ?? null,
    deployedAt: body.deployedAt ?? null,
    dirty: changedFiles.length > 0,
    changedFiles,
    localSha: filesSha(local),
  };
  if (json) {
    console.log(JSON.stringify(out));
    return;
  }
  console.log(`app:      ${out.app}`);
  console.log(`url:      ${out.url}`);
  console.log(`status:   ${out.deployStatus}${out.deployError ? ` (${out.deployError})` : ""}`);
  console.log(`version:  latest v${out.latestVersion}, deployed ${out.deployedVersion ? `v${out.deployedVersion}${out.deployedAt ? ` (${ago(out.deployedAt)} ago)` : ""}` : "never"}`);
  console.log(out.dirty
    ? `local:    ⚠ ${changedFiles.length} file(s) differ from pushed version — run: appato push`
    : `local:    in sync with pushed version`);
  console.log(`APPATO_STATUS app=${out.app} deployed_version=${out.deployedVersion ?? "none"} deployed_at=${out.deployedAt ?? "never"} dirty=${out.dirty} sha=${out.localSha} url=${out.url}`);
}

function upgrade() {
  console.log("Upgrading appato CLI…");
  const self = new URL(import.meta.url).pathname;
  if (self.includes("/.appato/bin/")) {
    // Self-hosted install: re-fetch the latest script from the platform.
    execSync(`curl -fsSL ${DEFAULT_HOST}/cli/appato.mjs -o "${self}"`, { stdio: "inherit" });
    console.log(`Updated ${self} → v${execSync(`node "${self}" --version`).toString().trim()}`);
  } else {
    // npm-installed (future) or dev checkout.
    execSync("npm install -g appato@latest", { stdio: "inherit" });
  }
}

// ---------------------------------------------------------------------------
// helpers

function collectFiles(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (IGNORE.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
      } else if (stats.size <= MAX_FILE_BYTES) {
        files[relative(root, full)] = readFileSync(full, "utf8");
      } else {
        console.error(`skipping ${relative(root, full)} (> ${MAX_FILE_BYTES} bytes)`);
      }
    }
  };
  walk(root);
  return files;
}

/** Deterministic short hash of a file set (path + content, sorted). */
function filesSha(files) {
  const h = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    h.update(path).update("\0").update(files[path]).update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

/** Paths that differ between local files and the last-pushed version. */
function diffFiles(local, remote) {
  const paths = new Set([...Object.keys(local), ...Object.keys(remote)]);
  return [...paths].filter((p) => local[p] !== remote[p]).sort();
}

function ago(msEpoch) {
  const s = Math.max(0, Math.round((Date.now() - msEpoch) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function tryOpen(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // fine — user opens the printed URL manually
  }
}
