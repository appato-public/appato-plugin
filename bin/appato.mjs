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
import { gzipSync } from "node:zlib";

const VERSION = "0.7.0";
const DEFAULT_HOST = process.env.APPATO_HOST || "https://appato.com";
const CRED_DIR = join(homedir(), ".appato");
const CRED_FILE = join(CRED_DIR, "credentials.json");
const PENDING_FILE = join(CRED_DIR, "pending-login.json");
// Never uploaded: appato.json is metadata, and _appato.d.ts is a leftover the
// CLI used to write and no longer does — existing checkouts still have one,
// and an app must never ship it (the real _appato.js is injected at deploy).
const IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  ".appato",
  "appato.json",
  "_appato.d.ts",
]);
const MAX_FILE_BYTES = 512 * 1024;
// Server-enforced too (PlanLimits.maxAssetBytes, the source of truth —
// Cloudflare's 25 MiB per-asset serving ceiling). Refuse, never skip.
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

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
    case "history": await history(args); break;
    case "cron": case "crons": await cron(args); break;
    case "rollback": await rollback(args); break;
    case "status": await status(args.includes("--json")); break;
    case "logs": await logs(args); break;
    case "sdk": case "howto": case "docs": sdkHelp(); break;
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
  appato history [--json] [--all]  list versions with their change summaries
                            (newest 50 by default; --all walks every page
                            your plan's history window retains)
  appato cron [--json]      list the app's schedules, next runs, last results
  appato cron run <name>    run a schedule now (test it without waiting)
  appato cron pause|resume <name>
                            stop/restart a schedule (schedules themselves are
                            declared in appato.json)
  appato rollback <version> restore a previous version's files as a new
                            version and deploy it (nothing is lost —
                            history is append-only; see appato history)
  appato sdk                how to build apps: platform APIs (storage,
                            realtime, identity), conventions, recipes
  appato logs [--all] [--since <2h|30m|7d>] [-n <count>] [--errors]
              [--user <email>] [--source <csv>] [--json]
                            the app's recent logs, errors first — a bounded
                            snapshot since the deployed version went live
                            (--all: everything retained; exits immediately)
  appato logs --console [--since <1h|24h>] [-n <count>] [--json]
                            raw server console.log output (~7-day window)
  appato install            install/update the CLI into ~/.appato/bin
  appato upgrade            same as install (update to the latest version)`);
}

/** The app-building reference, for agents (and humans) who need the API
 * surface without the plugin skill at hand. Mirror of the appato skill —
 * keep the two in sync when the platform SDK changes. */
function sdkHelp() {
  console.log(`Building apps on appato — the platform API reference

APPS
  One directory per app; entrypoint index.ts (or .js) exports a fetch
  handler. Plain TS/JS ES modules — NO npm deps, no package.json, no
  bundler. Serve HTML/CSS/JS inline from the fetch handler. The platform
  handles ALL auth — never build login. The /_appato/* URL path is
  reserved (your handler never sees it). Every push deploys.

SERVER SDK — import from "./_appato.js" (injected at deploy; never create it)
  getUser(request)      -> { id, email, name, org } | null   (verified)
  requireUser(request)  -> same, or throws a 401 Response
  getCron(request)      -> { name, scheduledAt, trigger } | null
  requireCron(request)  -> same, or throws a 404 Response
  EVERY read and write names a SCOPE — there is no unscoped store. The
  platform enforces it with the identity it verified, so you never write an
  auth check and no key can reach another scope.

    storage.shared     every org member reads + writes   <- the default
    storage.mine       (BROWSER ONLY) just that person, both directions
    storage.readonly   your server writes; browsers only read
    storage.internal   (SERVER ONLY) browsers cannot read, write, or see it
    storage.forUser(id)  (SERVER ONLY) one person's "mine" data

  Pick with one question: whose data is this? The team's -> shared. One
  human's -> mine. Computed by your server -> readonly if the browser should
  see it, internal if not.

  Each scope has the same verbs (keys are relative to the scope):
    .get(key)                 -> value | undefined
    .set(key, value)             values: any JSON <= 128KB
    .delete(key)
    .list(prefix, { limit, reverse, after }) -> [{ key, value, by, at }]
    .push(prefix, value)      -> key  (server-assigned time-sortable id:
                                 keys under a prefix sort chronologically)
    .increment(key, by = 1)   -> new value  (atomic counter)
    .watch(prefix, cb)        (BROWSER ONLY — see below)
  A scope omits the verbs it forbids: browser "readonly" has no set/delete/
  push/increment, so a forbidden call fails at once instead of round-tripping.

  Not scoped, server-only:
    storage.sql(query, params)       -> { rows, rowsRead, rowsWritten }
    storage.sqlBatch([{ query, params }, ...]) -> one transaction
    publish(event, data, channel = "main")   ephemeral broadcast to clients

  Keys are strings; use "/"-separated prefixes as collections
  ("messages/", "votes/"). Nothing is reserved — the same key in two scopes
  is two different values. SQL = the app's own private SQLite; table names
  starting with _appato_ are reserved; SQL emits NO realtime events and has
  no browser equivalent — use it only for what KV can't do: aggregates,
  joins, sorting by value, more than ~500 rows.

  "by" on an entry is the platform-verified writer ({ id, name }, or null
  when the app's server wrote it). Never keep your own "author" field: a
  browser can put any name in a value, but it cannot forge "by".

BROWSER SDK — in your served HTML:
  <script type="module">
    import { appato } from "/_appato/client.js";
    appato.user                       // { id, email, name, org } — verified
    const { shared, mine, readonly } = appato.storage;
        // same verbs per scope; internal/sql/forUser are absent here
    shared.watch("messages/", (entries) => { ... });
        // live query: fires with ALL entries under the prefix immediately
        // and on every change, sorted by key. Reconnects re-sync
        // automatically — never write polling or WebSocket code.
        // entries: [{ key, value, by, at }]
    mine.watch("drafts/", (entries) => { ... });   // this person's own only
    const room = appato.channel();    // default channel "main"
    room.publish("reaction", { x: 1 });         // not echoed to sender
    room.on("reaction", (data, from) => ...);   // from = { id, name }
    room.presence.set({ status: "here" });      // patch-merge; auto-leave
    room.presence.on((members) => ...);         // [{ user, data }]
  </script>

FILES (uploads) — the SAME scopes, a second verb set, backed by R2
  storage is for JSON <= 128KB; files are for blobs (images, PDFs, exports).
  Every call names a scope, resolved by the platform against the identity it
  verified — exactly like storage, so no signed or unguessable URLs.

    files.shared / files.readonly / files.internal  (SERVER, ./_appato.js)
    files.forUser(id)                               (SERVER — one person's)
    appato.files.shared / .mine / .readonly         (BROWSER, client.js)

  Verbs (keys are relative to the scope):
    .put(key, body, { contentType }?)  -> { key, url }
        server body: string | ArrayBuffer | Blob | ReadableStream
        browser body: a File/Blob (contentType: file.type, else octet-stream)
    .get(key)     -> the fetch Response, hardened headers included, or
                     undefined if missing. Serve it straight back:
                     return await files.internal.get(key)
    .delete(key)
    .list(prefix, { cursor, limit }?) -> { files: [{ key, size, contentType,
                                          by, at }], cursor? }
    .url(key)     -> app-relative "/_appato/files?scope=…&key=…"

  url() exists ONLY where a browser could actually load the result:
  server shared/readonly and browser shared/mine/readonly. internal and
  forUser have NO url() — a URL can carry neither server-only nor cross-user
  authority, so the missing method is a TypeError, not a link that leaks. A
  browser <img src={appato.files.mine.url("avatar")}> shows each viewer their
  OWN file (identity is resolved at the wall, not in the URL).

  Every served file gets nosniff + a CSP sandbox, so even a mis-typed HTML
  or SVG upload can't script your app. Limits: 25MB/file, ~1GB/app.

  Attachments only some people may see = files.internal + your own route:
    // index.ts — a DM attachment, visible to its two participants only
    if (url.pathname.startsWith("/att/")) {
      const me = requireUser(request);
      const dm = await storage.internal.get("att/" + url.pathname.slice(5));
      if (!dm || (me.id !== dm.from && me.id !== dm.to)) return new Response("no", { status: 403 });
      return (await files.internal.get(dm.fileKey)) ?? new Response("gone", { status: 404 });
    }

THREE TIERS — picking the right one matters
  storage   persisted        messages, votes, rows, settings
  presence  while tab open   who's here, typing status
  broadcast never stored     reactions, pings, cursor moves
  Never store presence-shaped data in storage; never expect a broadcast
  to be replayed.

RECIPES
  chat       shared.push + shared.watch + presence
  poll       shared.increment + shared.watch
  tracker    shared.set/list + shared.watch
  dashboard  readonly.watch (+ server publish() for ticks)
  drafts     mine.set + mine.watch          (per-person, private)
  cursors    channel broadcast only

SCHEDULES (cron) — declare in appato.json, handle in your fetch handler
  "crons": [
    { "name": "friday-reminder", "schedule": "0 9 * * 5", "tz": "America/Chicago" }
  ]
  The platform POSTs /cron/<name> at each fire (override with "path").
  ALWAYS set "tz" (IANA) when the user says a wall-clock time — without it
  the schedule is UTC and drifts an hour across daylight saving.

  import { requireCron, storage } from "./_appato.js";
  if (url.pathname === "/cron/friday-reminder") {
    requireCron(request);   // 404s anything that isn't a real scheduled fire
    ...do the work...
    return new Response("ok");
  }

  Non-2xx (or no response in 5 min) = a failed run; 10 consecutive failures
  auto-pause the schedule. Runs never overlap (a late run skips the next
  fire) and missed fires are skipped, never backfilled.
  Test without waiting: appato cron run <name> · appato cron (list/status)

LIMITS (flat, per app)
  128KB/value · ~100MB total · watch <= 500 entries/prefix (paginate with
  list/SQL past that) · presence data <= 2KB · broadcast <= 32KB
  files: 25MB/file · ~1GB/app · 1000 files/app
  schedules: plan-dependent (typically 10/app, min 1 min apart)

WORKFLOW
  appato status -> sync before editing -> edit -> appato push -m "..."
  (push output ends with a machine-readable APPATO_* line; parse that)
  LOGS: after a failing probe or a bug report, run appato logs — an
  errors-first bounded snapshot since the deployed version went live
  (exits immediately; it never follows). Check it BEFORE adding debug
  endpoints or guessing at a cause.`);
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

/**
 * The app's schedules, as manifest entries. Schedules are replace-all on
 * push, so any local copy MUST carry them or the next push deletes them —
 * which is why anything but a 404 (server predates schedules) aborts the
 * caller rather than quietly returning an empty set. `verb` names the
 * operation in that error.
 */
async function fetchCrons(org, app, verb) {
  const res = await apiFetch(`/api/apps/${org}/${app}/crons`);
  if (res.ok) {
    return (await res.json()).crons.map((c) => ({
      name: c.name,
      schedule: c.schedule,
      ...(c.tz ? { tz: c.tz } : {}),
      ...(c.path ? { path: c.path } : {}),
    }));
  }
  if (res.status === 404) return [];
  throw new Error(
    `couldn't read ${org}/${app}'s schedules (${res.status}) — stopping instead of ${verb} with an incomplete appato.json, which the next push would treat as "delete every schedule". Retry in a moment.`,
  );
}

/** Rewrite appato.json's `crons` in place -> true if it changed. */
function writeManifestCrons(root, crons) {
  const path = join(root, "appato.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const before = JSON.stringify(manifest.crons ?? []);
  if (crons.length === 0) delete manifest.crons;
  else manifest.crons = crons;
  if (JSON.stringify(manifest.crons ?? []) === before) return false;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  return true;
}

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

  // The manifest names every file; contents come one raw fetch per path,
  // addressed by hash (race-free against a push landing mid-clone) — same
  // loop as sync, because no endpoint returns a full file set as JSON
  // (docs/SYNC.md S33). fetchManifest's no_versions branch answers an empty
  // set for a new app; "no such app" was already excluded above.
  const man = await fetchManifest(org, slug);
  const incoming = {};
  for (const [path, hash] of Object.entries(man.files)) {
    incoming[path] = await fetchFile(org, slug, path, hash);
  }

  const crons = await fetchCrons(org, slug, "cloning");

  mkdirSync(dir, { recursive: true });
  writeFiles(dir, incoming);
  writeFileSync(
    join(dir, "appato.json"),
    JSON.stringify(
      {
        org,
        app: slug,
        title: state.title || slug,
        description: state.description || "",
        ...(crons.length ? { crons } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  const rel = relative(process.cwd(), dir);
  const fileCount = Object.keys(man.files).length;
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
  const { org, app, title, description, crons, root } = appConfig();
  const message = flagValue(args, "-m") ?? flagValue(args, "--message");
  const details = flagValue(args, "--details") ?? "";
  if (!message) {
    throw new Error(
      'a change summary is required: appato push -m "one-line, user-facing summary" [--details "a short paragraph: what changed for users, why, and any notable decisions"]',
    );
  }
  const { files, binary } = collectFiles(root);
  if (Object.keys(files).length === 0 && Object.keys(binary).length === 0) {
    throw new Error("no files to push");
  }
  const binHashes = binaryHashes(binary);
  const sha = localSetSha(files, binHashes);
  const meta = {
    message,
    details,
    title,
    description,
    crons: crons === undefined ? [] : crons,
  };
  // Send only what differs from the version already on the server. The base
  // comes from a fresh manifest fetch (~1 KB) rather than a local cache: the
  // CLI keeps no state on disk by design (see the header comment), and a
  // cache is the exact thing that goes stale and then silently pushes the
  // wrong delta. Source is hashed fresh either way (docs/SYNC.md S6), so
  // the fetch costs a round trip and buys correctness outright.
  const man = await safeManifest(org, app);
  // Binary bytes go up FIRST, as raw blob PUTs (never inside the JSON —
  // S16), and only the ones the server doesn't already resolve: an
  // unchanged image uploads once, ever. The push then carries references.
  const known = new Set(Object.values(man?.files ?? {}));
  for (const [path, bytes] of Object.entries(binary)) {
    if (!known.has(binHashes[path])) await putBlob(org, app, path, bytes);
  }
  let res = await pushRequest(org, app, files, binHashes, deltaAgainst(man, files, binHashes), meta);
  let body = await res.json();
  if (res.status === 409 && body.code === "missing_blob") {
    // The base manifest told us a blob existed but the push disagreed —
    // upload everything we have and say the whole thing.
    for (const [path, bytes] of Object.entries(binary)) await putBlob(org, app, path, bytes);
    res = await pushRequest(org, app, files, binHashes, null, meta);
    body = await res.json();
  }
  if (res.status === 409 && body.code === "base_stale") {
    // The server could not reconstruct what we described — someone pushed
    // in between, or our view was wrong. Say the whole thing instead.
    res = await pushRequest(org, app, files, binHashes, null, meta);
    body = await res.json();
  }
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
  // The manifest, not the files: {path: sha256} is a few hundred bytes
  // against the whole app, and it is enough to decide everything below.
  // Content is fetched per differing path, addressed by hash so a push
  // landing mid-sync cannot swap the bytes underneath us.
  const man = await fetchManifest(org, app);
  // Schedules live in appato.json, which is excluded from the file hashes —
  // so without this a sync could report "up to date" while the manifest
  // held stale schedules, and the next push would restore them over the
  // real ones. Refresh them first, whatever the file comparison decides.
  const cronsChanged = writeManifestCrons(root, await fetchCrons(org, app, "syncing"));
  if (cronsChanged) console.log("✓ schedules updated in appato.json");
  const local = collectFiles(root);
  const localBinHashes = binaryHashes(local.binary);
  const localSha = localSetSha(local.files, localBinHashes);
  const localHashes = { ...hashFiles(local.files), ...localBinHashes };
  const changed = manifestDiff(localHashes, man.files);

  if (changed.length === 0) {
    console.log(`Already up to date (v${man.version}).`);
    console.log(`APPATO_SYNCED app=${org}/${app} version=${man.version} changed=false sha=${localSha}`);
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
    if (!match && Object.keys(localHashes).length > 0) {
      console.error(`✗ local files don't match any pushed version — syncing would discard changes in:`);
      for (const p of changed) console.error(`    ${p}`);
      console.error(`Push them first (appato push -m "...") or discard them: appato sync --force`);
      console.log(`APPATO_SYNC_BLOCKED app=${org}/${app} latest_version=${man.version} local_sha=${localSha}`);
      process.exit(2);
    }
  }

  // Download EVERYTHING before touching the working tree. Interleaving the
  // two meant a failure partway through left a checkout that was half one
  // version and half another — and `filesSha` of that mixture matches no
  // pushed version, so the next sync would refuse to run and the next push
  // would commit the mixture.
  const incoming = {};
  for (const path of changed) {
    if (path in man.files) incoming[path] = await fetchFile(org, app, path, man.files[path]);
  }
  writeFiles(root, incoming);
  for (const path of changed) {
    if (!(path in man.files)) unlinkSync(join(root, path));
  }
  // Local now equals the pushed version, so the set hash of the new tree IS
  // that version's sha — the same 12-hex contract every other command
  // emits. Deliberately not the manifest's sha256: they are different
  // hashes with different jobs (docs/SYNC.md S4).
  const synced = collectFiles(root);
  const syncedSha = localSetSha(synced.files, binaryHashes(synced.binary));
  console.log(`✓ synced to v${man.version} — ${changed.length} file(s) changed`);
  console.log(`APPATO_SYNCED app=${org}/${app} version=${man.version} changed=true files=${changed.length} sha=${syncedSha}`);
}

async function rollback(args = []) {
  const { org, app } = appConfig();
  const raw = args.find((a) => /^v?\d+$/.test(a));
  const target = raw ? Number(raw.replace(/^v/, "")) : NaN;
  if (!Number.isInteger(target) || target < 1) {
    throw new Error('usage: appato rollback <version> — pick one from appato history');
  }
  const res = await apiFetch(`/api/apps/${org}/${app}/rollback`, {
    method: "POST",
    body: JSON.stringify({ version: target }),
  });
  const body = await res.json();
  if (res.status === 422) {
    console.error(`✗ created v${body.version} from v${target}, but deploy FAILED:\n  ${body.deployError}`);
    console.error("The previously deployed version keeps serving.");
    console.log(`APPATO_DEPLOY_FAILED app=${org}/${app} version=${body.version} error=${JSON.stringify(body.deployError ?? "unknown")}`);
    process.exit(2);
  }
  if (!res.ok) throw new Error(body.error || `rollback failed (${res.status})`);
  // `restored` is the version that authored the content — it differs from
  // the target when the target was itself a rollback (server resolves to
  // the origin so rollback chains never form).
  const restored = body.restored ?? target;
  const what = restored === target ? `v${target}` : `v${restored}'s code, via v${target}`;
  console.log(`✓ rolled back — v${body.version} now live (restored ${what}) → ${body.url}`);
  console.log(`Local files are now behind the new version; run: appato sync`);
  console.log(`APPATO_ROLLED_BACK app=${org}/${app} version=${body.version} restored=${restored} url=${body.url}`);
}

async function history(args = []) {
  const json = args.includes("--json");
  const all = args.includes("--all");
  const { org, app } = appConfig();
  // The server pages at 50 (nextBefore = the id cursor for the next older
  // page); --all walks the pages until the plan's history window runs out.
  // The cursor strictly decreases, so this always terminates.
  const versions = [];
  let cursor = 0;
  let truncated = false;
  do {
    const res = await apiFetch(
      `/api/apps/${org}/${app}/versions${cursor ? `?before=${cursor}` : ""}`,
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `history failed (${res.status})`);
    versions.push(...body.versions);
    truncated = !all && !!body.nextBefore;
    cursor = all ? (body.nextBefore ?? 0) : 0;
  } while (cursor);
  if (json) {
    console.log(JSON.stringify(versions));
    return;
  }
  for (const v of versions) {
    const flag = v.deployStatus === "deployed" ? "✓" : v.deployStatus === "error" ? "✗" : "·";
    console.log(`${flag} v${v.id}  ${ago(v.createdAt)}  ${v.message || "(no message)"}`);
    if (v.details) console.log(`     ${v.details.replace(/\n/g, "\n     ")}`);
  }
  // Rollback accepts any version id, so older targets work either way —
  // this is a discovery hint only.
  if (truncated) {
    console.log(`… older versions exist — run: appato history --all`);
  }
}

/**
 * Schedules (docs/CRON.md). `cron` lists them; `run` fires one immediately
 * so a Friday job can be tested on a Tuesday; pause/resume are runtime
 * state. The schedules themselves live in appato.json — this command never
 * edits them (code is the source of truth; the platform only operates it).
 */
async function cron(args = []) {
  const { org, app } = appConfig();
  const [sub, name] = args.filter((a) => !a.startsWith("-"));

  if (sub && sub !== "list") {
    if (!["run", "pause", "resume"].includes(sub)) {
      throw new Error(`unknown cron command "${sub}" — use: list | run <name> | pause <name> | resume <name>`);
    }
    if (!name) throw new Error(`usage: appato cron ${sub} <name>`);
    const res = await apiFetch(`/api/apps/${org}/${app}/crons/${name}/${sub}`, { method: "POST" });
    const body = await res.json();
    if (res.status === 404) throw new Error(body.error || `no cron "${name}" in appato.json`);
    if (sub === "run") {
      const ok = res.ok && body.status === "ok";
      const detail = body.error ? ` — ${body.error}` : "";
      console.log(`${ok ? "✓" : "✗"} ran "${name}" (${body.status}, ${body.durationMs}ms)${detail}`);
      // What the handler returned. The point of a test run is seeing what the
      // job actually DID, not just that it exited 2xx.
      if (body.output) {
        for (const line of String(body.output).split("\n")) console.log(`     ${line}`);
      }
      console.log(
        `APPATO_CRON_RUN app=${org}/${app} name=${name} status=${body.status} http=${body.httpStatus ?? "none"} duration_ms=${body.durationMs ?? 0} error=${JSON.stringify(body.error ?? "")} output=${JSON.stringify(body.output ?? "")}`,
      );
      if (!ok) process.exit(2);
      return;
    }
    if (!res.ok) throw new Error(body.error || `cron ${sub} failed (${res.status})`);
    console.log(`✓ ${sub}d "${name}"`);
    console.log(`APPATO_CRON_${sub.toUpperCase()}D app=${org}/${app} name=${name}`);
    return;
  }

  const res = await apiFetch(`/api/apps/${org}/${app}/crons`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `cron list failed (${res.status})`);
  if (args.includes("--json")) {
    console.log(JSON.stringify(body));
    return;
  }
  if (body.crons.length === 0) {
    console.log(`No schedules. Add a "crons" array to appato.json and push:`);
    console.log(`  "crons": [{ "name": "friday-reminder", "schedule": "0 9 * * 5", "tz": "America/Chicago" }]`);
    console.log(`Your app handles POST /cron/<name> (see: appato sdk).`);
  } else {
    if (body.suspended) console.log(`⚠ app is archived — no schedule runs until it's live again`);
    for (const c of body.crons) {
      const when = c.paused
        ? c.pausedBy === "auto"
          ? `PAUSED after ${c.consecutiveFailures} failures`
          : "paused"
        : c.nextAt
          ? `next ${until(c.nextAt)}`
          : "not scheduled";
      const last = c.lastRun ? `  last ${c.lastRun.status} ${ago(c.lastRun.startedAt)}` : "";
      console.log(`${c.paused ? "⏸" : "●"} ${c.name}  ${c.schedule}${c.tz ? ` ${c.tz}` : " UTC"}  ${when}${last}`);
      if (c.lastRun?.error) console.log(`     ${c.lastRun.error}`);
    }
  }
  console.log(`APPATO_CRONS app=${org}/${app} count=${body.crons.length} suspended=${body.suspended}`);
  for (const c of body.crons) {
    console.log(
      `APPATO_CRON name=${c.name} schedule=${JSON.stringify(c.schedule)} tz=${c.tz ?? "UTC"} paused=${c.paused} paused_by=${c.pausedBy ?? "none"} next_at=${c.nextAt ?? "none"} failures=${c.consecutiveFailures} last_status=${c.lastRun?.status ?? "never"}`,
    );
  }
}

/**
 * Runtime logs (docs/LOGS.md L13): a bounded snapshot that EXITS — never a
 * blocking follow. One request returns error groups, the timeline slice,
 * and the summary; errors print first, stacks are never truncated (an
 * agent debugging from frames needs every one). Default window: since the
 * deployed version went live (the server defaults when no `since` is
 * sent), so a post-push check sees only what that push produced. The final
 * APPATO_LOGS line is part of the machine contract (see push above).
 */
async function logs(args = []) {
  if (args.includes("--console")) return consoleLogs(args);
  const { org, app } = appConfig();
  const params = new URLSearchParams();
  if (args.includes("--all")) params.set("since", "0");
  else if (flagValue(args, "--since") !== undefined) {
    params.set("since", String(parseSince(flagValue(args, "--since"))));
  }
  if (flagValue(args, "-n") !== undefined) params.set("limit", flagValue(args, "-n"));
  if (args.includes("--errors")) params.set("errors", "1");
  if (flagValue(args, "--user") !== undefined) params.set("user", flagValue(args, "--user"));
  if (flagValue(args, "--source") !== undefined) params.set("source", flagValue(args, "--source"));

  const qs = params.toString();
  const res = await apiFetch(`/api/apps/${org}/${app}/logs${qs ? `?${qs}` : ""}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `logs failed (${res.status})`);
  if (args.includes("--json")) {
    console.log(JSON.stringify(body));
    return;
  }

  const s = body.summary;
  const groups = body.groups ?? [];
  const events = [...(body.events ?? [])].sort((a, b) => a.ts - b.ts);

  // Errors first (L13): grouped, with the sample's FULL stack — never cut.
  if (groups.length > 0) {
    console.log(`── errors ──`);
    for (const g of groups) {
      console.log(
        `✗ ${g.type}: ${g.sample?.message ?? ""} ×${g.count}  first v${g.firstV} ${ago(g.firstTs)} · last v${g.lastV} ${ago(g.lastTs)}`,
      );
      for (const f of g.sample?.exception?.frames ?? []) {
        console.log(`    at ${f.function} (${f.filename}:${f.lineno}:${f.colno})`);
      }
      // Auto-blame: which push likely introduced this (server-computed).
      if (g.blame) {
        console.log(
          g.blame.file
            ? `    introduced in v${g.blame.version} ("${g.blame.message}") — touched ${g.blame.file}`
            : `    first seen in v${g.blame.version} ("${g.blame.message}")`,
        );
      }
    }
  }
  // Client↔server join: a browser-side failed fetch and the server error it
  // hit share a request id — print them as one story, not two loose rows.
  // Twin: serverErrorsByRid in web/src/features/apps/logs.ts — keep the join
  // rule (rid + error level + http/app source) identical, or the CLI and
  // the console tell different stories about the same request.
  const serverErrByRid = new Map();
  for (const e of events) {
    if (e.rid && e.level === "error" && (e.source === "http" || e.source === "app")) {
      serverErrByRid.set(e.rid, e);
    }
  }
  // Client-side drop reports (L5): the browser SDK ships its own drop
  // counts as a client_report event with {reason: count} in context —
  // render the counts and total them for the machine line's
  // client_dropped. Twin: eventText in web/src/features/apps/logs.ts —
  // keep the rendered text identical.
  let clientDropped = 0;
  const dropReport = (e) => {
    if (e.message !== "client_report" || typeof e.context !== "object" || !e.context || Array.isArray(e.context)) return null;
    const counts = Object.entries(e.context).filter(([, n]) => typeof n === "number" && n > 0);
    if (counts.length === 0) return null;
    for (const [, n] of counts) clientDropped += n;
    return `browser SDK dropped events: ${counts.map(([reason, n]) => `${reason} ×${n}`).join(", ")}`;
  };
  for (const e of events) {
    const v = e.v != null && e.v !== body.deployedVersion ? ` [v${e.v}]` : "";
    const who = e.userEmail ? ` (${e.userEmail})` : "";
    // Per-row truncation (L5): the row itself says capture cut it, not just
    // the summary's single boolean. Twin: the truncated chip in
    // web/src/features/apps/Logs.tsx EventRow.
    const cut = e.truncated ? " [truncated]" : "";
    // NO duration printed until `request.ms` means response time — it is
    // currently time-to-headers, which excludes the slowest part of a
    // streamed response. The console shows it labeled "server time"; here
    // the flat line stays duration-free (agents read ms as latency).
    console.log(`${hms(e.ts)} ${e.source} ${e.level} ${dropReport(e) ?? e.message}${v}${who}${cut}`);
    if (e.source === "browser" && e.rid) {
      const srv = serverErrByRid.get(e.rid);
      if (srv) console.log(`    ↳ server, same request: ${srv.message}`);
    }
  }
  if (s.entries === 0 && groups.length === 0) {
    const deployed = body.deployedVersion
      ? `since v${body.deployedVersion} deployed${body.deployedAt ? ` ${ago(body.deployedAt)}` : ""}`
      : "yet";
    console.log(
      `No log events ${deployed}. (Server console.log output lives in the firehose: \`appato logs --console\`.)`,
    );
  }
  if (s.stale > 0) {
    console.log(
      `⚠ ${s.stale} error(s) are from versions older than v${body.deployedVersion} — likely pre-fix; ignore unless they recur on the current version.`,
    );
  }
  // L5: the picture may be incomplete, but never silently so.
  if (s.dropped > 0 || clientDropped > 0 || s.truncated) {
    const parts = [];
    if (s.dropped > 0) parts.push(`${s.dropped} event(s) were dropped at capture (rate/size caps)`);
    if (clientDropped > 0) parts.push(`${clientDropped} event(s) were dropped in the browser before sending`);
    if (s.truncated) parts.push(`some entries are truncated`);
    console.log(`⚠ ${parts.join("; ")} — the picture above is incomplete.`);
  }
  console.log(
    `APPATO_LOGS app=${org}/${app} deployed_version=${body.deployedVersion ?? "none"} window_since=${body.since} entries=${s.entries} errors=${s.errors} error_groups=${s.errorGroups} stale_errors=${s.stale} dropped=${s.dropped} client_dropped=${clientDropped} truncated=${!!s.truncated}`,
  );
}

/** The server console firehose (docs/LOGS.md L3): full console.log output
 * from Workers Logs, ~7-day retention, 1h window by default. Separate from
 * the durable timeline — this is print-debugging's home. */
async function consoleLogs(args) {
  const { org, app } = appConfig();
  const params = new URLSearchParams();
  const since = flagValue(args, "--since");
  if (since) params.set("since", String(parseSince(since)));
  const n = flagValue(args, "-n");
  if (n) params.set("limit", n);
  const res = await apiFetch(`/api/apps/${org}/${app}/logs/console?${params}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `console logs failed (${res.status})`);
  if (args.includes("--json")) {
    console.log(JSON.stringify(body));
    return;
  }
  const events = [...(body.events ?? [])].sort((a, b) => a.ts - b.ts);
  for (const e of events) {
    const req = e.request ? ` [${e.request.method} ${e.request.path}]` : "";
    console.log(`${hms(e.ts)} ${e.level} ${e.message}${req}`);
    if (e.stack) for (const l of String(e.stack).split("\n")) console.log(`    ${l.trim()}`);
  }
  if (events.length === 0) {
    console.log(`No server console output in this window (default 1h; --since 24h reaches back; ~7-day retention).`);
  }
  console.log(`APPATO_LOGS_CONSOLE app=${org}/${app} window_since=${body.since} entries=${events.length}`);
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
  // Two small reads: app metadata (no file contents) and the manifest.
  // `status` used to download the entire app on every invocation — which
  // the agent skill runs every turn — purely to produce a list of changed
  // FILENAMES. Comparing hashes answers exactly the same question for a
  // few hundred bytes (docs/SYNC.md).
  const [res, man] = await Promise.all([
    apiFetch(`/api/apps/${org}/${app}`),
    fetchManifest(org, app),
  ]);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `status failed (${res.status})`);
  const local = collectFiles(root);
  const localBinHashes = binaryHashes(local.binary);
  const localSha = localSetSha(local.files, localBinHashes);
  const changedFiles = manifestDiff(
    { ...hashFiles(local.files), ...localBinHashes },
    man.files,
  );
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
  if (body.archived) {
    console.log(`status:   archived — not serving; the app's owner can make it live again in the console`);
  } else {
    console.log(`status:   ${out.deployStatus}${out.deployError ? ` (${out.deployError})` : ""}`);
  }
  console.log(`version:  latest v${out.latestVersion}, deployed ${out.deployedVersion ? `v${out.deployedVersion}${out.deployedAt ? ` (${ago(out.deployedAt)})` : ""}` : "never"}`);
  if (!dirty) {
    console.log(`local:    in sync with pushed version`);
  } else if (syncState === "behind") {
    console.log(`local:    ⚠ behind — local matches v${matchesVersion}, latest is v${out.latestVersion}; run: appato sync`);
  } else {
    console.log(`local:    ⚠ ${changedFiles.length} file(s) with unpushed changes — run: appato push`);
  }
  console.log(`APPATO_STATUS app=${out.app} deployed_version=${out.deployedVersion ?? "none"} deployed_at=${out.deployedAt ?? "never"} dirty=${out.dirty} state=${syncState} archived=${body.archived ?? false} sha=${out.localSha} url=${out.url}`);
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
    title: a.name + (a.status === "archived" ? "  [archived]" : ""),
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

/**
 * Walk the app directory into `{files, binary}`: text files as strings,
 * binary files as Buffers. The classification is the bytes' own shape —
 * bytes that round-trip through UTF-8 are text (Node's decoder replaces
 * invalid sequences with U+FFFD instead of failing, so re-encode-and-compare
 * is the only honest test; docs/SYNC.md S16). The server enforces the same
 * split on both wires: push refuses lone surrogates, PUT /blob refuses
 * valid UTF-8 (B5 — a check that matters is enforced on both ends).
 *
 * Caps refuse, never skip. Skipping printed a warning and pushed anyway, so
 * the deployed app silently lacked the file — and because the omission also
 * kept it out of filesSha, `status` reported in-sync over an app that was
 * missing it (docs/SYNC.md B7, S11).
 */
function collectFiles(root) {
  const files = {};
  const binary = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (IGNORE.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
      } else {
        const rel = relative(root, full);
        const bytes = readFileSync(full);
        const text = bytes.toString("utf8");
        if (Buffer.from(text, "utf8").equals(bytes)) {
          if (stats.size > MAX_FILE_BYTES) {
            throw new Error(
              `${rel} is ${stats.size} bytes, over the ${MAX_FILE_BYTES}-byte limit for a single source file. Remove it from the app directory (or move it outside) and push again.`,
            );
          }
          files[rel] = text;
        } else {
          if (stats.size > MAX_ASSET_BYTES) {
            throw new Error(
              `${rel} is ${stats.size} bytes, over the ${MAX_ASSET_BYTES}-byte limit for a single asset. Remove it from the app directory (or move it outside) and push again.`,
            );
          }
          binary[rel] = bytes;
        }
      }
    }
  };
  walk(root);
  return { files, binary };
}

/** Write a {path: content} file set under root, refusing unsafe paths.
 *  Values are strings (text) or Buffers (binary) — writeFileSync takes
 *  both, so the two kinds converge here. */
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
 * Content address for one file.
 * MUST stay byte-identical to sha256Hex() in src/hash.ts on the server —
 * these are the addresses the manifest is expressed in, so a divergence
 * would make every file look changed.
 */
function sha256Hex(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Content address for one BINARY file — sha256 over raw bytes (a text
 * file's two forms hash identically, since its bytes ARE its UTF-8).
 * MUST stay byte-identical to sha256HexBytes() in src/hash.ts — these
 * addresses decide which blobs need uploading before a push.
 */
function sha256HexBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `{path: sha256}` for the binary half of a local tree. */
function binaryHashes(binary) {
  const out = {};
  for (const [path, bytes] of Object.entries(binary)) out[path] = sha256HexBytes(bytes);
  return out;
}

/**
 * The 12-hex set hash over BOTH halves. Binary files enter by their sha256
 * hex as a content stand-in — the server computes the identical stand-in
 * from its stored references (src/do/app.ts push), so neither side needs
 * the other's bytes to agree on identity.
 */
function localSetSha(files, binHashes) {
  return filesSha({ ...files, ...binHashes });
}

/**
 * Deterministic short hash of a file set (path + content, sorted).
 * MUST stay byte-identical to filesSha() in src/hash.ts on the server — sync
 * compares this against version shas from the API.
 */
function filesSha(files) {
  const h = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    h.update(path).update("\0").update(files[path] ?? "").update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

/** {path: sha256} for a local file set — the shape the server publishes. */
function hashFiles(files) {
  const out = {};
  for (const [path, content] of Object.entries(files)) out[path] = sha256Hex(content);
  return out;
}

/** Paths that differ between two {path: sha256} maps, including either
 *  side's additions and deletions. Comparing hashes rather than content is
 *  what lets `status` answer without downloading anything. */
function manifestDiff(local, remote) {
  const paths = new Set([...Object.keys(local), ...Object.keys(remote)]);
  return [...paths].filter((p) => local[p] !== remote[p]).sort();
}

async function fetchManifest(org, app) {
  const res = await apiFetch(`/api/apps/${org}/${app}/manifest`);
  const body = await res.json();
  // A 404 is ambiguous: "this app has no versions yet" and "this app does
  // not exist" look identical from here. Only the first may become an empty
  // manifest — treating the second that way makes a deleted or renamed app
  // look like an app with no files, and `sync --force` then unlinks the
  // entire local checkout on the strength of it.
  if (res.status === 404) {
    if (body.code === "no_versions") return { version: 0, sha256: "", files: {} };
    throw new Error(
      `no app "${app}" in ${org} — it may have been deleted or renamed. Run \`appato status --all\` to list the org's apps.`,
    );
  }
  if (!res.ok) throw new Error(body.error || `could not read ${org}/${app} (${res.status})`);
  return body;
}

/**
 * The manifest to diff a push against, or null to send everything.
 *
 * Swallows every failure on purpose. The manifest is an OPTIMIZATION for
 * push — it decides how much we send, never whether we can send. A new app
 * has no versions, a network blip has no manifest, and neither is a reason
 * to refuse someone's work; both just mean the push carries the full set,
 * which is what it always used to do. Real problems (no such app, no seat,
 * archived) surface from the push itself, which is the request that
 * actually knows.
 *
 * Note this is the opposite call from sync, where a missing manifest was
 * treated as an empty app and DELETED the checkout. The difference is what
 * failure costs: bytes here, data there.
 */
async function safeManifest(org, app) {
  try {
    const man = await fetchManifest(org, app);
    return man.version > 0 ? man : null;
  } catch {
    return null;
  }
}

/**
 * What differs between the server's manifest and the local tree, or null if
 * there is no usable base. `files` carries only changed/added TEXT content;
 * `deleted` names paths the server has and we do not (either kind — the
 * server prunes text via this list; binary is replaced wholesale by the
 * complete `binary` map, since a reference is ~50 bytes and needs no delta
 * encoding). `sha256` binds BOTH halves so neither can silently drop.
 */
function deltaAgainst(man, local, binHashes) {
  if (!man) return null;
  const localHashes = hashFiles(local);
  const changed = {};
  for (const [path, content] of Object.entries(local)) {
    if (man.files[path] !== localHashes[path]) changed[path] = content;
  }
  // A path leaves `deleted` only if it is still text locally OR its base
  // entry is exactly the binary blob we are re-referencing. A path that
  // CHANGED KIND (text→binary) must be deleted from the base's text set,
  // or the server reconstructs it as text AND receives a binary reference
  // for it — both-kinds, refused. (Binary→binary unchanged matches the
  // hash and stays out of the list; the reference re-adds it regardless.)
  const deleted = Object.keys(man.files).filter(
    (p) => !(p in local) && man.files[p] !== binHashes[p],
  );
  return {
    base: man.version,
    files: changed,
    deleted,
    sha256: manifestSha({ ...localHashes, ...binHashes }),
  };
}

/**
 * POST a push. Gzipped, signalled by a header we own rather than
 * Content-Encoding — workerd does not reliably strip that coding after
 * decompressing, so a Worker cannot tell whether it holds compressed bytes
 * (docs/SYNC.md S8).
 *
 * `delta` null means "send the whole set", which is also what an older
 * server understands: `base` absent is a full push (S5).
 */
async function pushRequest(org, app, files, binHashes, delta, meta) {
  // title/description/crons come from appato.json — the manifest is the
  // source of truth for app metadata AND schedules, synced on every push
  // (crons replace-all: omitting one removes it). `binary` is ALWAYS the
  // complete `{path: sha256}` reference map — the bytes went up via
  // PUT /blob before this request, so the push itself never carries them
  // (binary never touches JSON — docs/SYNC.md S16).
  const payload = delta
    ? { ...meta, base: delta.base, files: delta.files, deleted: delta.deleted, sha256: delta.sha256, binary: binHashes }
    : { ...meta, files, binary: binHashes };
  const gz = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  return apiFetch(`/api/apps/${org}/${app}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Appato-Encoding": "gzip" },
    body: gz,
  });
}

/**
 * Whole-set validator over a {path: sha256} map.
 * MUST stay byte-identical to manifestSha() in src/hash.ts — a delta push is
 * only safe because both ends compute this the same way: this states what
 * the full set hashes to, the server reconstructs and checks.
 */
function manifestSha(files) {
  return sha256Hex(JSON.stringify(Object.fromEntries(Object.entries(files).sort())));
}

/** One file's BYTES, addressed by hash so a push landing mid-sync can't
 *  swap the bytes we asked for. Returns a Buffer for every kind of file —
 *  downloads are bytes (docs/SYNC.md S33); text is its UTF-8. */
async function fetchFile(org, app, path, sha256) {
  const res = await apiFetch(
    `/api/apps/${org}/${app}/file?path=${encodeURIComponent(path)}&sha256=${sha256}`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `could not fetch ${path} (${res.status})`);
  }
  // Version-skew tolerance: a not-yet-propagated pre-0.7 server answers
  // JSON `{content}`; the current wire is raw octet-stream. Without this
  // branch, that window writes a JSON envelope into the working tree as
  // file content.
  if ((res.headers.get("content-type") || "").includes("application/json")) {
    const body = await res.json();
    return Buffer.from(body.content, "utf8");
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Upload one binary file's bytes, raw — no JSON, no base64, no gzip
 * (assets are already-compressed formats). The server hashes what it
 * received and answers with the address (docs/SYNC.md S22); the following
 * push carries that address as a reference.
 */
async function putBlob(org, app, path, bytes) {
  const res = await apiFetch(`/api/apps/${org}/${app}/blob`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `could not upload ${path} (${res.status})`);
  return body.sha256;
}

// Same contract as web/src/lib/time.ts ago(): the "ago" is included.
// (Deliberately duplicated — the CLI stays a single dependency-free file.)
function ago(msEpoch) {
  const s = Math.max(0, Math.round((Date.now() - msEpoch) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Same contract as web/src/lib/time.ts until(): the "in" is included.
// (Deliberately duplicated — see the note on ago().)
function until(msEpoch) {
  const s = Math.max(0, Math.round((msEpoch - Date.now()) / 1000));
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

/** Short local clock time (HH:MM:SS) for log lines. */
function hms(msEpoch) {
  return new Date(msEpoch).toTimeString().slice(0, 8);
}

/** "--since 2h" (s/m/h/d suffixes) → an absolute ms epoch; raw ms pass through. */
function parseSince(raw) {
  const rel = /^(\d+(?:\.\d+)?)([smhd])$/.exec(raw);
  if (rel) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2]];
    return Date.now() - Math.round(Number(rel[1]) * unit);
  }
  if (/^\d+$/.test(raw)) return Number(raw);
  throw new Error(`--since expects a duration like 30m, 2h, 7d, or an ms epoch (got "${raw}")`);
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
