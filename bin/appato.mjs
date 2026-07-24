#!/usr/bin/env node
// appato CLI — a deliberately thin REST client. All real logic is server-side;
// this walks files, holds a token, and relays deploy results. Agents drive it
// (see the appato skill), so stdout messages are written for them too.
//
// Anchoring: commands find their app by walking UP from cwd to the nearest
// appato.json (the app root). With no app above, `status` instead looks one
// level DOWN for checked-out apps and lists the org's apps — so launching in
// an app, a subdir of an app, or a directory of apps all orient correctly.
// There is no other state: no registry, no markers, no hidden files.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, dirname, basename } from "node:path";
import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";

const VERSION = "0.2.3";
const DEFAULT_HOST = process.env.APPATO_HOST || "https://appato.com";
const CRED_DIR = join(homedir(), ".appato");
const CRED_FILE = join(CRED_DIR, "credentials.json");
const PENDING_FILE = join(CRED_DIR, "pending-login.json");
const IGNORE = new Set(["node_modules", ".git", "dist", ".appato", "appato.json"]);
const MAX_FILE_BYTES = 512 * 1024;

const [, , command, ...args] = process.argv;

try {
  switch (command) {
    case "login": await login(args); break;
    case "logout": logout(); break;
    case "whoami": await whoami(); break;
    case "create": await create(args); break;
    case "clone": await clone(args); break;
    case "push": await push(args); break;
    case "sync": await sync(args); break;
    case "history": await history(args.includes("--json")); break;
    case "status": await status(args.includes("--json")); break;
    case "logs": console.log("logs: not implemented yet — coming in a future release"); break;
    case "install": await install(); break;
    case "upgrade": await install(); break;
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
  appato login [--no-wait]  authenticate this machine (opens browser).
                            --no-wait exits immediately after printing the
                            approval URL; the next appato command finishes
                            the login once you've approved
  appato logout             remove stored credentials
  appato whoami             show the signed-in user and orgs
  appato status [--json] [--all]
                            inside an app: deploy status, URL, local drift
                            elsewhere: list your apps + local checkouts
                            (--all: every app in the org)
  appato create <slug> --title "..." --description "..."  [--org <slug>]
                            create an app in a new ./<slug>/ directory
  appato clone <slug> [dir] [--org <slug>]
                            check out an existing app into ./<slug>/
  appato sync [--force]     update local files to the latest pushed version
                            (refuses to discard unpushed local changes)
  appato push -m "..." [--details "..."]
                            upload the app and deploy; also syncs
                            title/description from appato.json
  appato history [--json]   list versions with their change summaries
  appato logs               (soon) tail the app's logs
  appato install            install/update the CLI into ~/.appato/bin
  appato upgrade            same as install (update to the latest version)`);
}

// ---------------------------------------------------------------------------
// auth

/**
 * Device-flow login, resumable by design: the pending device code is saved
 * to disk the moment it's minted, so login survives the polling process
 * dying (agent Bash timeouts, closed terminals, classifier kills). Approval
 * order doesn't matter — any later appato command completes the exchange
 * via credentials(). `--no-wait` prints the approval URL and exits
 * immediately (the agent-friendly path).
 */
async function login(args = []) {
  const host = DEFAULT_HOST;
  let pending = readPendingLogin();
  if (!pending || pending.host !== host) {
    const codeRes = await fetch(`${host}/api/auth/device/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "appato-cli" }),
    });
    if (!codeRes.ok) throw new Error(`device flow unavailable (${codeRes.status})`);
    const code = await codeRes.json();
    pending = {
      host,
      device_code: code.device_code,
      verify_url: code.verification_uri_complete || code.verification_uri,
      interval: code.interval || 5,
      expires_at: Date.now() + (code.expires_in || 1800) * 1000,
    };
    mkdirSync(CRED_DIR, { recursive: true });
    writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2), { mode: 0o600 });
  }
  console.log(`Open to approve this device:\n  ${pending.verify_url}`);
  tryOpen(pending.verify_url);

  if (args.includes("--no-wait")) {
    console.log(
      "After approving in the browser, run any appato command (e.g. `appato whoami`) — it completes the login automatically.",
    );
    console.log(`APPATO_LOGIN_PENDING url=${pending.verify_url} expires_at=${pending.expires_at}`);
    return;
  }

  while (Date.now() < pending.expires_at) {
    await new Promise((r) => setTimeout(r, pending.interval * 1000));
    if (await exchangePendingLogin(pending)) {
      await whoami();
      return;
    }
  }
  rmPendingLogin();
  throw new Error("login timed out — run appato login again");
}

/** One token-exchange attempt. True = logged in; false = still pending. */
async function exchangePendingLogin(pending) {
  const res = await fetch(`${pending.host}/api/auth/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: pending.device_code,
      client_id: "appato-cli",
    }),
  });
  if (res.ok) {
    const token = await res.json();
    // Device-flow session token, sent as Authorization: Bearer.
    // TODO: exchange for a long-lived API key once the server supports it.
    const cred = { host: pending.host, bearer: token.access_token };
    mkdirSync(CRED_DIR, { recursive: true });
    writeFileSync(CRED_FILE, JSON.stringify(cred, null, 2), { mode: 0o600 });
    rmPendingLogin();
    console.log("Logged in.");
    return true;
  }
  const body = await res.json().catch(() => ({}));
  if (body.error === "authorization_pending" || body.error === "slow_down") return false;
  rmPendingLogin();
  throw new Error(`login failed: ${body.error || res.status}`);
}

function readPendingLogin() {
  try {
    const p = JSON.parse(readFileSync(PENDING_FILE, "utf8"));
    if (p.device_code && p.expires_at > Date.now()) return p;
  } catch {
    // no pending login
  }
  return null;
}

function rmPendingLogin() {
  try {
    unlinkSync(PENDING_FILE);
  } catch {
    // already gone
  }
}

function logout() {
  writeFileSync(CRED_FILE, "{}");
  rmPendingLogin();
  console.log("Logged out.");
}

/** Stored credentials — or, when absent, finish a pending device login. */
async function credentials() {
  if (existsSync(CRED_FILE)) {
    const cred = JSON.parse(readFileSync(CRED_FILE, "utf8"));
    if (cred.bearer) return cred;
  }
  const pending = readPendingLogin();
  if (pending) {
    if (await exchangePendingLogin(pending)) {
      return JSON.parse(readFileSync(CRED_FILE, "utf8"));
    }
    throw new Error(
      `login pending approval — approve at ${pending.verify_url} then retry this command`,
    );
  }
  throw new Error("not logged in — run: appato login");
}

async function apiFetch(path, options = {}) {
  const cred = await credentials();
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
// anchoring

/** Nearest ancestor directory (including cwd) containing appato.json. */
function findAppRoot(from = process.cwd()) {
  let dir = from;
  while (true) {
    if (existsSync(join(dir, "appato.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function appConfig() {
  const root = findAppRoot();
  if (!root) {
    throw new Error(
      "not inside an appato app (no appato.json here or above) — " +
        "run `appato status` to see your org's apps, `appato clone <slug>` to check one out, " +
        "or `appato create <slug>` to start a new one",
    );
  }
  const config = JSON.parse(readFileSync(join(root, "appato.json"), "utf8"));
  return { ...config, root };
}

/** Immediate child directories of `base` that are app checkouts. */
function scanChildApps(base) {
  const out = [];
  for (const entry of readdirSync(base)) {
    if (entry.startsWith(".") || IGNORE.has(entry)) continue;
    const manifest = join(base, entry, "appato.json");
    try {
      if (!statSync(join(base, entry)).isDirectory() || !existsSync(manifest)) continue;
      const m = JSON.parse(readFileSync(manifest, "utf8"));
      if (m.org && m.app) out.push({ org: m.org, app: m.app, dir: entry });
    } catch {
      // unreadable entry — not a checkout
    }
  }
  return out;
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
  const inside = findAppRoot();
  if (inside) {
    throw new Error(
      `already inside an appato app (${inside}) — apps don't nest; cd out and create it as a sibling`,
    );
  }
  // Directory = bare app slug. If cwd is already named after the app (the
  // "mkdir first" habit), use it; otherwise create ./<slug>/.
  const dir = basename(process.cwd()) === slug ? process.cwd() : join(process.cwd(), slug);
  if (dir !== process.cwd() && existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`./${slug}/ already exists and is not empty`);
  }
  const res = await apiFetch("/api/apps", {
    method: "POST",
    body: JSON.stringify({ slug, org, title, description }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `create failed (${res.status})`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "appato.json"),
    JSON.stringify({ org: body.org, app: body.slug, title, description }, null, 2) + "\n",
  );
  const rel = relative(process.cwd(), dir) || ".";
  console.log(`Created ${body.org}/${body.slug} — "${title}" in ${rel === "." ? "this directory" : `./${rel}/`}`);
  console.log(`URL (after first push): ${body.url}`);
  console.log(`APPATO_CREATED app=${body.org}/${body.slug} dir=${JSON.stringify(rel)} url=${body.url}`);
}

async function clone(args) {
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-")) i++;
    else positionals.push(args[i]);
  }
  const slug = positionals[0];
  const orgFlag = flagValue(args, "--org");
  if (!slug) throw new Error("usage: appato clone <slug> [dir] [--org <org>]");
  const inside = findAppRoot();
  if (inside) {
    throw new Error(`already inside an appato app (${inside}) — apps don't nest; cd out first`);
  }
  const org = orgFlag ?? (await defaultOrg());

  const existing = scanChildApps(process.cwd()).find((c) => c.org === org && c.app === slug);
  if (existing) {
    console.log(`${org}/${slug} is already checked out at ./${existing.dir}/ — cd in and run: appato sync`);
    console.log(`APPATO_CLONED app=${org}/${slug} dir=${JSON.stringify(existing.dir)} existing=true`);
    return;
  }

  const dir = join(process.cwd(), positionals[1] || slug);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${relative(process.cwd(), dir)}/ already exists and is not empty`);
  }
  const stateRes = await apiFetch(`/api/apps/${org}/${slug}`);
  const state = await stateRes.json();
  if (stateRes.status === 404) {
    throw new Error(`no app "${slug}" in ${org} — run \`appato status --all\` to list the org's apps`);
  }
  if (!stateRes.ok) throw new Error(state.error || `clone failed (${stateRes.status})`);

  mkdirSync(dir, { recursive: true });
  writeFiles(dir, state.files ?? {});
  writeFileSync(
    join(dir, "appato.json"),
    JSON.stringify(
      { org, app: slug, title: state.title || slug, description: state.description || "" },
      null,
      2,
    ) + "\n",
  );
  const rel = relative(process.cwd(), dir);
  const fileCount = Object.keys(state.files ?? {}).length;
  console.log(
    state.latestVersion > 0
      ? `Cloned ${org}/${slug} v${state.latestVersion} (${fileCount} files) → ./${rel}/`
      : `Cloned ${org}/${slug} (no versions pushed yet) → ./${rel}/`,
  );
  console.log(`APPATO_CLONED app=${org}/${slug} version=${state.latestVersion} dir=${JSON.stringify(rel)} url=${state.url}`);
}

// The final APPATO_* line of push/sync/status is a stable machine contract for
// driving agents (see SKILL.md): space-separated key=value pairs, values
// JSON-encoded when they may contain spaces. Don't reword these lines.
async function push(args = []) {
  const { org, app, title, description, root } = appConfig();
  const message = flagValue(args, "-m") ?? flagValue(args, "--message");
  const details = flagValue(args, "--details") ?? "";
  if (!message) {
    throw new Error(
      'a change summary is required: appato push -m "one-line, user-facing summary" [--details "a short paragraph: what changed for users, why, and any notable decisions"]',
    );
  }
  const files = collectFiles(root);
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

async function sync(args = []) {
  const { org, app, root } = appConfig();
  const force = args.includes("--force");
  const res = await apiFetch(`/api/apps/${org}/${app}`);
  const state = await res.json();
  if (!res.ok) throw new Error(state.error || `sync failed (${res.status})`);
  const remote = state.files ?? {};
  const local = collectFiles(root);
  const localSha = filesSha(local);
  const remoteSha = filesSha(remote);

  if (localSha === remoteSha) {
    console.log(`Already up to date (v${state.latestVersion}).`);
    console.log(`APPATO_SYNCED app=${org}/${app} version=${state.latestVersion} changed=false sha=${remoteSha}`);
    return;
  }

  if (!force) {
    // Safe to overwrite only if the local copy is exactly some pushed version
    // (then nothing would be lost — it's all in history). Otherwise there are
    // unpushed local edits and sync must not discard them.
    const vres = await apiFetch(`/api/apps/${org}/${app}/versions`);
    const vbody = await vres.json();
    if (!vres.ok) throw new Error(vbody.error || `sync failed (${vres.status})`);
    const match = vbody.versions.find((v) => v.sha === localSha);
    if (!match && Object.keys(local).length > 0) {
      const changed = diffFiles(local, remote);
      console.error(`✗ local files don't match any pushed version — syncing would discard changes in:`);
      for (const p of changed) console.error(`    ${p}`);
      console.error(`Push them first (appato push -m "...") or discard them: appato sync --force`);
      console.log(`APPATO_SYNC_BLOCKED app=${org}/${app} latest_version=${state.latestVersion} local_sha=${localSha}`);
      process.exit(2);
    }
  }

  const changed = diffFiles(local, remote);
  writeFiles(root, remote);
  for (const path of Object.keys(local)) {
    if (!(path in remote)) unlinkSync(join(root, path));
  }
  console.log(`✓ synced to v${state.latestVersion} — ${changed.length} file(s) changed`);
  console.log(`APPATO_SYNCED app=${org}/${app} version=${state.latestVersion} changed=true files=${changed.length} sha=${remoteSha}`);
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

/** First org membership — the default when --org isn't given. */
async function defaultOrg() {
  const res = await apiFetch("/api/me");
  if (!res.ok) throw new Error("unauthorized — run: appato login");
  const me = await res.json();
  const org = me.orgs[0]?.slug;
  if (!org) throw new Error("you're not in an org yet — create one at " + DEFAULT_HOST);
  return org;
}

async function status(json = false) {
  const root = findAppRoot();
  if (!root) return workspaceStatus(json, args.includes("--all"));

  const { org, app } = appConfig();
  const res = await apiFetch(`/api/apps/${org}/${app}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `status failed (${res.status})`);
  const local = collectFiles(root);
  const localSha = filesSha(local);
  const changedFiles = diffFiles(local, body.files ?? {});
  const dirty = changedFiles.length > 0;

  // Distinguish "behind" (local equals an older pushed version — sync) from
  // "modified" (unpushed local edits — push) via version content hashes.
  let syncState = "in_sync";
  let matchesVersion = body.latestVersion;
  if (dirty) {
    const vres = await apiFetch(`/api/apps/${org}/${app}/versions`);
    const vbody = await vres.json();
    const match = vres.ok ? vbody.versions.find((v) => v.sha === localSha) : undefined;
    syncState = match ? "behind" : "modified";
    matchesVersion = match ? match.id : null;
  }

  const out = {
    app: `${org}/${app}`,
    url: body.url,
    deployStatus: body.deployStatus,
    deployError: body.deployError ?? null,
    latestVersion: body.latestVersion,
    deployedVersion: body.deployedVersion ?? null,
    deployedAt: body.deployedAt ?? null,
    dirty,
    syncState,
    matchesVersion,
    changedFiles,
    localSha,
  };
  if (json) {
    console.log(JSON.stringify(out));
    return;
  }
  console.log(`app:      ${out.app}`);
  console.log(`url:      ${out.url}`);
  console.log(`status:   ${out.deployStatus}${out.deployError ? ` (${out.deployError})` : ""}`);
  console.log(`version:  latest v${out.latestVersion}, deployed ${out.deployedVersion ? `v${out.deployedVersion}${out.deployedAt ? ` (${ago(out.deployedAt)} ago)` : ""}` : "never"}`);
  if (!dirty) {
    console.log(`local:    in sync with pushed version`);
  } else if (syncState === "behind") {
    console.log(`local:    ⚠ behind — local matches v${matchesVersion}, latest is v${out.latestVersion}; run: appato sync`);
  } else {
    console.log(`local:    ⚠ ${changedFiles.length} file(s) with unpushed changes — run: appato push`);
  }
  console.log(`APPATO_STATUS app=${out.app} deployed_version=${out.deployedVersion ?? "none"} deployed_at=${out.deployedAt ?? "never"} dirty=${out.dirty} state=${syncState} sha=${out.localSha} url=${out.url}`);
}

/**
 * `status` outside any app: the caller's own apps (orgs can be huge, so the
 * full list is opt-in via --all) + every checkout one level down, whoever
 * created it.
 */
async function workspaceStatus(json = false, all = false) {
  const res = await apiFetch(`/api/apps${all ? "" : "?mine=1"}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `status failed (${res.status})`);
  const local = scanChildApps(process.cwd());
  const localByApp = new Map(local.map((c) => [`${c.org}/${c.app}`, c.dir]));
  const apps = body.apps.map((a) => ({
    slug: a.slug,
    title: a.name,
    dir: localByApp.get(`${body.org}/${a.slug}`) ?? null,
  }));
  // Checkouts of apps outside the fetched list (e.g. a coworker's app you
  // cloned) still belong in the picture.
  const listed = new Set(apps.map((a) => a.slug));
  for (const c of local) {
    if (c.org === body.org && !listed.has(c.app)) {
      apps.push({ slug: c.app, title: "(created by someone else)", dir: c.dir });
    }
  }
  const scope = all ? "all" : "mine";
  if (json) {
    console.log(JSON.stringify({ org: body.org, scope, apps }));
    return;
  }
  if (apps.length === 0) {
    console.log(
      all
        ? `No apps in ${body.org} yet — start one: appato create <slug> --title "..." --description "..."`
        : `No apps of yours in ${body.org} yet — create one, or \`appato status --all\` to see everyone's.`,
    );
  } else {
    console.log(`${all ? "All apps" : "Your apps"} in ${body.org} (● = checked out below this directory):`);
    for (const a of apps) {
      console.log(
        a.dir
          ? `  ● ${a.slug}  ${a.title}  → ./${a.dir}/`
          : `  ○ ${a.slug}  ${a.title}  (appato clone ${a.slug})`,
      );
    }
    if (!all) console.log(`(yours only — \`appato status --all\` lists the whole org)`);
  }
  console.log(`APPATO_WORKSPACE org=${body.org} scope=${scope} apps=${apps.length} checked_out=${apps.filter((a) => a.dir).length}`);
  for (const a of apps) {
    console.log(`APPATO_APP app=${body.org}/${a.slug} dir=${a.dir ? JSON.stringify("./" + a.dir) : "none"}`);
  }
}

/**
 * Install (or update) the CLI into ~/.appato/bin — used both as
 * `appato upgrade` from an installed copy and as the bootstrap path from the
 * plugin-bundled copy (`node "$CLAUDE_PLUGIN_ROOT/bin/appato.mjs" install`),
 * so skills never need curl/chmod shell of their own. Fetches the latest
 * script from the platform; falls back to copying this file's own bytes
 * when offline.
 */
async function install() {
  const binDir = join(homedir(), ".appato", "bin");
  const target = join(binDir, "appato.mjs");
  mkdirSync(binDir, { recursive: true });

  let source = "latest from " + DEFAULT_HOST;
  try {
    const res = await fetch(`${DEFAULT_HOST}/cli/appato.mjs`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(target, await res.text());
  } catch {
    // Offline / blocked: self-copy so the bundled plugin CLI still installs.
    const self = new URL(import.meta.url).pathname;
    if (self === target) throw new Error("could not reach " + DEFAULT_HOST + " to update");
    writeFileSync(target, readFileSync(self));
    source = "bundled copy (offline — run `appato upgrade` later for the latest)";
  }

  const wrapper = join(binDir, "appato");
  writeFileSync(wrapper, `#!/bin/sh\nexec node "${target}" "$@"\n`, { mode: 0o755 });

  const version = execSync(`node "${target}" --version`).toString().trim();
  console.log(`Installed appato v${version} (${source}) → ${wrapper}`);
  if (!(process.env.PATH ?? "").split(":").includes(binDir)) {
    console.log(`Not on PATH — use ${wrapper} directly, or add: export PATH="$HOME/.appato/bin:$PATH"`);
  }
  console.log(`APPATO_INSTALLED version=${version} path=${JSON.stringify(wrapper)}`);
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

/** Write a {path: content} file set under root, refusing unsafe paths. */
function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    if (path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
      console.error(`skipping unsafe path: ${path}`);
      continue;
    }
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/**
 * Deterministic short hash of a file set (path + content, sorted).
 * MUST stay byte-identical to filesSha() in src/hash.ts on the server — sync
 * compares this against version shas from the API.
 */
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
