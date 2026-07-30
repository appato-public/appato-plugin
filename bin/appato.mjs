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

//
// GENERATED FILE — do not edit. Authored in cli/src/*.mjs; rebuild with
// `npm run build:cli`. `npm run verify` fails when this file is stale.

import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";

// ---------------------------------------------------------------------------
// cli/src/config.mjs

const VERSION = "0.10.0";

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

// Cloudflare's real 25 MiB per-asset serving CEILING — a platform constant,
// so the client may pre-check it (unlike a plan knob, which the server owns:
// a client literal would wrongly block a plan with a higher limit). The
// per-source-file size limit is a plan knob (PlanLimits.maxFileBytes), so the
// server's reject at push is the only enforcement. Refuse, never skip.
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// cli/src/machine.mjs

/**
 * The CLI's machine-readable output contract. Agents parse these lines; human
 * output is deliberately separate. This declaration is the single owner of
 * field order, types, quoting, absent sentinels, and the exact field variants
 * each token may emit.
 *
 * `absent` is the literal wire value written when a present field is null or
 * undefined. It bypasses the normal quote rule (`none`, `never`, `null`,
 * `""`, and `0` are intentionally distinct conventions).
 */

const machineString = (name, quote = "raw", absent) => ({
  name,
  type: "string",
  quote,
  ...(absent === undefined ? {} : { absent }),
});
const machineInteger = (name, absent) => ({
  name,
  type: "integer",
  quote: "raw",
  ...(absent === undefined ? {} : { absent }),
});
const machineBoolean = (name) => ({ name, type: "boolean", quote: "raw" });
const machineLine = (fields, variants = [fields.map((field) => field.name)]) => ({
  fields,
  variants,
});

const MACHINE_LINE_CONTRACT = {
  APPATO_ERROR: machineLine(
    [machineString("code"), machineString("message", "json"), machineString("action_url", "json")],
    [
      ["code", "message"],
      ["code", "message", "action_url"],
    ],
  ),
  APPATO_APP: machineLine([machineString("app"), machineString("dir", "json", "none")]),
  APPATO_CLONED: machineLine(
    [
      machineString("app"),
      machineInteger("version"),
      machineString("dir", "json"),
      machineString("url"),
      machineBoolean("existing"),
    ],
    [
      ["app", "dir", "existing"],
      ["app", "version", "dir", "url"],
    ],
  ),
  APPATO_CREATED: machineLine([
    machineString("app"),
    machineString("dir", "json"),
    machineString("url"),
  ]),
  APPATO_CRON: machineLine([
    machineString("name", "json"),
    machineString("schedule", "json"),
    machineString("tz", "raw", "UTC"),
    machineBoolean("paused"),
    machineString("paused_by", "raw", "none"),
    machineInteger("next_at", "none"),
    machineInteger("failures"),
    machineString("last_status", "raw", "never"),
  ]),
  APPATO_CRONS: machineLine([
    machineString("app"),
    machineInteger("count"),
    machineBoolean("suspended"),
  ]),
  APPATO_CRON_PAUSED: machineLine([machineString("app"), machineString("name", "json")]),
  APPATO_CRON_RESUMED: machineLine([machineString("app"), machineString("name", "json")]),
  APPATO_CRON_RUN: machineLine([
    machineString("app"),
    machineString("name", "json"),
    machineString("status"),
    machineInteger("http", "none"),
    machineInteger("duration_ms", "0"),
    machineString("error", "json", '""'),
    machineString("output", "json", '""'),
  ]),
  APPATO_DATA: machineLine([
    machineString("app"),
    machineInteger("tables"),
    machineInteger("kv_shared"),
    machineInteger("kv_readonly"),
    machineInteger("kv_internal"),
    machineInteger("people"),
    machineInteger("size_bytes"),
    machineInteger("sessions"),
  ]),
  APPATO_DELETED: machineLine([machineString("app")]),
  APPATO_DEPLOYED: machineLine([
    machineString("app"),
    machineInteger("version"),
    machineString("sha"),
    machineString("url"),
  ]),
  APPATO_DEPLOY_FAILED: machineLine(
    [
      machineString("app"),
      machineInteger("version"),
      machineString("sha"),
      machineString("error", "json", '"unknown"'),
    ],
    [
      ["app", "version", "sha", "error"],
      ["app", "version", "error"],
    ],
  ),
  APPATO_FILE: machineLine(
    [
      machineString("app"),
      machineString("scope"),
      machineString("key", "json"),
      machineBoolean("found"),
      machineInteger("size"),
      machineString("type", "json"),
      machineString("by", "json", "null"),
      machineInteger("at"),
    ],
    [
      ["key", "size", "type", "by", "at"],
      ["app", "scope", "key", "found"],
    ],
  ),
  APPATO_FILES: machineLine([
    machineString("app"),
    machineInteger("shared"),
    machineInteger("readonly"),
    machineInteger("internal"),
    machineInteger("people"),
    machineInteger("total"),
    machineInteger("bytes"),
  ]),
  APPATO_FILE_DELETED: machineLine([
    machineString("app"),
    machineString("scope"),
    machineString("key", "json"),
    machineBoolean("existed"),
  ]),
  APPATO_FILE_LIST: machineLine([
    machineString("app"),
    machineString("scope"),
    machineString("user", "raw", "none"),
    machineString("prefix", "json"),
    machineInteger("count"),
    machineBoolean("truncated"),
  ]),
  APPATO_FILE_PUT: machineLine([
    machineString("app"),
    machineString("scope"),
    machineString("key", "json"),
    machineInteger("size"),
    machineString("type", "json"),
  ]),
  APPATO_FILE_SAVED: machineLine([
    machineString("app"),
    machineString("scope"),
    machineString("key", "json"),
    machineInteger("size"),
    machineString("type", "json"),
    machineString("to", "json", "stdout"),
  ]),
  APPATO_EMAIL: machineLine([
    machineString("app"),
    machineString("namespace"),
    machineString("inbound"),
    machineString("outbound"),
    machineBoolean("desired_inbound"),
    machineBoolean("desired_outbound"),
  ]),
  APPATO_EMAIL_READY: machineLine([
    machineString("app"),
    machineString("direction"),
    machineBoolean("enabled"),
    machineString("inbound"),
    machineString("outbound"),
  ]),
  APPATO_EMAILS: machineLine([
    machineString("app"),
    machineInteger("count"),
    machineString("next_cursor", "json", "none"),
  ]),
  APPATO_EMAIL_MESSAGE: machineLine([
    machineString("app"),
    machineString("id"),
    machineString("direction"),
    machineString("status"),
    machineString("from", "json", "none"),
    machineString("to", "json", "none"),
    machineString("subject", "json"),
    machineInteger("occurred_at"),
  ]),
  APPATO_INSTALLED: machineLine([machineString("version"), machineString("path", "json")]),
  APPATO_KEY: machineLine([
    machineString("key", "json"),
    machineString("by", "json", "null"),
    machineInteger("at"),
  ]),
  APPATO_KEYS: machineLine([
    machineString("app"),
    machineString("scope"),
    machineString("user", "raw", "none"),
    machineString("prefix", "json"),
    machineInteger("count"),
    machineBoolean("truncated"),
  ]),
  APPATO_KV: machineLine(
    [
      machineString("app"),
      machineString("scope"),
      machineString("key", "json"),
      machineBoolean("found"),
      machineString("by", "json", "null"),
      machineInteger("at"),
    ],
    [
      ["app", "scope", "key", "found"],
      ["app", "scope", "key", "found", "by", "at"],
    ],
  ),
  APPATO_KV_DELETED: machineLine([
    machineString("app"),
    machineString("scope"),
    machineString("key", "json"),
    machineBoolean("existed"),
  ]),
  APPATO_KV_SET: machineLine([
    machineString("app"),
    machineString("scope"),
    machineString("key", "json"),
  ]),
  APPATO_LOGIN_COMPLETE: machineLine([
    machineString("user", "json"),
    machineString("orgs", "json", '""'),
  ]),
  APPATO_LOGIN_PENDING: machineLine([machineString("url"), machineInteger("expires_at")]),
  APPATO_LOGS: machineLine([
    machineString("app"),
    machineInteger("deployed_version", "none"),
    machineInteger("window_since"),
    machineInteger("entries"),
    machineInteger("errors"),
    machineInteger("error_groups"),
    machineInteger("stale_errors"),
    machineInteger("dropped"),
    machineInteger("client_dropped"),
    machineBoolean("truncated"),
  ]),
  APPATO_LOGS_CONSOLE: machineLine([
    machineString("app"),
    machineInteger("window_since"),
    machineInteger("entries"),
  ]),
  APPATO_PAUSED: machineLine([machineString("app")]),
  APPATO_RESTORED: machineLine([machineString("app"), machineString("url", "raw", "none")]),
  APPATO_RESUMED: machineLine([machineString("app"), machineString("url", "raw", "none")]),
  APPATO_ROLLED_BACK: machineLine([
    machineString("app"),
    machineInteger("version"),
    machineInteger("restored"),
    machineString("url"),
  ]),
  APPATO_SHOW: machineLine([
    machineString("app"),
    machineInteger("version"),
    machineInteger("files"),
  ]),
  APPATO_SQL: machineLine([
    machineString("app"),
    machineInteger("rows"),
    machineInteger("rows_read"),
    machineInteger("rows_written"),
    machineBoolean("truncated"),
    machineBoolean("write"),
  ]),
  APPATO_STATUS: machineLine([
    machineString("app"),
    machineInteger("deployed_version", "none"),
    machineInteger("deployed_at", "never"),
    machineBoolean("dirty"),
    machineString("state"),
    machineString("status", "raw", "active"),
    machineInteger("deletes_at", "none"),
    machineString("sha"),
    machineString("url"),
  ]),
  APPATO_SYNCED: machineLine(
    [
      machineString("app"),
      machineInteger("version"),
      machineBoolean("changed"),
      machineInteger("files"),
      machineString("sha"),
    ],
    [
      ["app", "version", "changed", "sha"],
      ["app", "version", "changed", "files", "sha"],
    ],
  ),
  APPATO_SYNC_BLOCKED: machineLine([
    machineString("app"),
    machineInteger("latest_version"),
    machineString("local_sha"),
  ]),
  APPATO_TABLE: machineLine([
    machineString("name", "json"),
    machineInteger("rows"),
    machineString("cols", "json"),
  ]),
  APPATO_TRASHED: machineLine([machineString("app"), machineInteger("deletes_at", "none")]),
  APPATO_WEBHOOK: machineLine(
    [
      machineString("app"),
      machineString("label", "json"),
      machineString("url", "json"),
      machineInteger("created_at"),
      machineBoolean("created"),
    ],
    [
      ["app", "label", "url", "created_at"],
      ["app", "label", "url", "created_at", "created"],
    ],
  ),
  APPATO_WEBHOOK_DELETED: machineLine([machineString("app"), machineString("label", "json")]),
  APPATO_WEBHOOKS: machineLine([machineString("app"), machineInteger("count")]),
  APPATO_WORKSPACE: machineLine([
    machineString("org"),
    machineString("scope"),
    machineInteger("apps"),
    machineInteger("checked_out"),
  ]),
};

function formatMachineValue(token, field, value) {
  if (value === null || value === undefined) {
    if ("absent" in field) return field.absent;
    throw new Error(`${token}.${field.name} has no absent-value convention`);
  }

  if (field.type === "string") {
    if (typeof value !== "string") {
      throw new Error(`${token}.${field.name} must be a string`);
    }
  } else if (field.type === "integer") {
    if (!Number.isInteger(value)) {
      throw new Error(`${token}.${field.name} must be an integer`);
    }
  } else if (field.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new Error(`${token}.${field.name} must be a boolean`);
    }
  }

  if (field.quote === "json") return JSON.stringify(value);
  const raw = String(value);
  if (!raw || /\s/.test(raw)) {
    throw new Error(`${token}.${field.name} cannot be safely emitted without JSON quoting`);
  }
  return raw;
}

function formatMachineLine(token, values) {
  const line = MACHINE_LINE_CONTRACT[token];
  if (!line) throw new Error(`unknown machine-line token ${token}`);

  const names = Object.keys(values);
  const known = new Set(line.fields.map((field) => field.name));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(`${token} has unknown field(s): ${unknown.join(", ")}`);
  }
  const matches = line.variants.some(
    (variant) => variant.length === names.length && variant.every((name) => names.includes(name)),
  );
  if (!matches) {
    throw new Error(`${token} fields do not match a declared variant: ${names.join(", ")}`);
  }

  const fields = line.fields
    .filter((field) => Object.hasOwn(values, field.name))
    .map((field) => `${field.name}=${formatMachineValue(token, field, values[field.name])}`);
  return `${token} ${fields.join(" ")}`;
}

/** Emit one contract-owned line. `stderr` keeps streamed file bytes on stdout pure. */
function emit(token, values, stderr = false) {
  (stderr ? console.error : console.log)(formatMachineLine(token, values));
}

/** Preserve a server refusal's stable code/action in both human and machine output. */
function apiResponseError(body, fallback) {
  const message = typeof body?.error === "string" && body.error ? body.error : fallback;
  const actionUrl =
    typeof body?.actionUrl === "string" && body.actionUrl ? body.actionUrl : undefined;
  const error = /** @type {Error & {apiCode?: string, actionUrl?: string}} */ (
    new Error(actionUrl ? `${message}\nnext: ${actionUrl}` : message)
  );
  if (typeof body?.code === "string" && body.code) error.apiCode = body.code;
  if (actionUrl) error.actionUrl = actionUrl;
  return error;
}

// ---------------------------------------------------------------------------
// cli/src/help.mjs

function usage() {
  console.log(`appato ${VERSION} — build & deploy internal utility apps

usage:
  appato login [--no-wait|--watch]
                            authenticate this machine (opens browser).
                            --no-wait exits immediately after printing the
                            approval URL; the next appato command finishes
                            the login once you've approved.
                            --watch starts no login: it runs silently until
                            one lands, then prints APPATO_LOGIN_COMPLETE
                            (for agent harnesses; Ctrl-C to stop)
  appato logout             remove stored credentials
  appato whoami             show the signed-in user and orgs
  appato status [--json] [--all]
                            inside an app: deploy status, URL, local drift
                            elsewhere: list your apps + local checkouts
                            (--all: every app in the org)
  appato create <slug> --title "..." --description "..."  [--org <slug>]
                            [--emoji "📦"] [--label "Stock"]
                            create an app in ./<slug>/, adopting an existing
                            local manifest without dropping any fields
                            (--emoji: 1–2 emoji · --label: ≤8-char icon label)
  appato clone <slug> [dir] [--org <slug>] [--version <n>]
                            check out an existing app into ./<slug>/
                            (--version checks out that past version's files
                            and its own schedules, ready to sync or push)
  appato sync [--force]     update local files to the latest pushed version
                            (refuses to discard unpushed local changes)
  appato push -m "..." [--details "..."] [--model "..."]
                            upload the app and deploy; also syncs
                            title/description from appato.json
                            (--model: model id of the coding agent driving
                            this push, for telemetry)
  appato history [--json] [--all]  list versions with their change summaries
                            (newest 50 by default; --all walks every page
                            your plan's history window retains)
  appato show [version] [path] [-o <path>] [--json]
                            read a version without checking it out. No path:
                            its header, composition, and file list (version
                            defaults to the latest). With a path: that file's
                            bytes to stdout, or to -o <path>
  appato cron [--json]      list the app's schedules, next runs, last results
  appato cron run <name>    run a schedule now (test it without waiting)
  appato cron pause|resume <name>
                            stop/restart a schedule (schedules themselves are
                            declared in appato.json)
  appato webhook [--json]   list provisioned webhook labels and secret URLs
  appato webhook create <label>
                            request an opaque public URL for a snake_case label
  appato webhook delete <label>
                            revoke the URL immediately (recreate to rotate it)
  appato email status [--json]
                            show the app-owned address and inbound/outbound state
  appato email enable|disable inbound|outbound|both
                            change explicit email capabilities and refresh
                            their reflection in appato.json
  appato email logs [--since <2h>] [--direction inbound|outbound]
                            inspect metadata-only email history (also supports
                            --status, --from, --to, --alias, --category, -n/--limit)
  appato email get <message-id> [--body] [--json]
                            inspect one message; bodies are opt-in
  appato data               what the app has stored: tables, keys per scope,
                            people with personal data, size, live sessions
  appato data ls [prefix] [--scope shared|readonly|internal|mine] [--user <id|email>]
                            list a scope's keys (default shared; mine needs
                            --user to say whose)
  appato data get <key> [--scope ...] [--user ...]
                            print one value as JSON
  appato data set <key> <value|-> [--scope ...] [--user ...]
                            write one value (JSON if it parses, else a plain
                            string; "-" reads the value from stdin)
  appato data rm <key> [--scope ...] [--user ...]
                            delete one key
  appato data sql ["<statement>"] [--write] [--json]
                            run one SQL statement against the app's SQLite
                            (read-only unless --write). No statement: an
                            interactive REPL on a TTY, or one statement
                            read from stdin otherwise
  appato files              the app's uploaded files: count + bytes per scope,
                            people with personal files, quota used
  appato files ls [prefix] [--scope shared|readonly|internal|mine] [--user <id|email>]
                            list a scope's files (default shared; mine needs
                            --user to say whose)
  appato files get <key> [-o <path>] [--scope ...] [--user ...]
                            download one file to <path>, or to stdout if piped
  appato files put <path> [<key>] [--scope ...] [--user ...] [--type <mime>]
                            upload a local file (key defaults to its basename;
                            content type inferred from the extension)
  appato files rm <key> [--scope ...] [--user ...]
                            delete one file
  appato rollback <version> restore a previous version's files as a new
                            version and deploy it (nothing is lost —
                            history is append-only; see appato history)
  appato pause              take the app offline (maintenance): stops serving,
                            suspends schedules, freezes data — but keeps
                            everything, readable, and fully reversible
  appato resume             bring a paused app back: redeploy the last version
                            and unfreeze
  appato trash              move the app to the trash: offline + frozen, on a
                            countdown to permanent deletion (restorable until)
  appato restore            bring a trashed app back to active, exactly as it was
  appato delete <slug> --force [--org <org>]
                            permanently delete a TRASHED app and everything
                            behind it (code, data, files, logs). Irreversible;
                            refuses without --force
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
  bundler. For a browser UI, prefer index.html plus static CSS; index.html
  serves / before the fetch handler. Keep browser JavaScript inside the HTML
  for now because .js files are Worker modules, not static assets. Use the
  fetch handler for APIs, scheduled jobs, webhooks, and genuinely dynamic
  HTML. The platform handles ALL auth — never build login. The /_appato/*
  URL path is reserved (your handler never sees it). Every push deploys.

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

WEBHOOKS — provision an opaque public URL, then handle its stable label
  Request/list/revoke from the app checkout:
    appato webhook create slack_message
    appato webhook
    appato webhook delete slack_message

  Use the exact returned https://<app>-<org>.hooks.appato.app/<opaque-id>
  URL at the provider. Treat it as a secret capability; never derive it,
  commit it to app code, or log it. Register the LABEL at module scope:

    import { handleWebhook } from "./_appato.js";
    handleWebhook("slack_message", async (request, env, ctx) => {
      const bytes = await request.arrayBuffer();
      // Verify provider signature/challenge against the exact bytes first.
      return new Response("ok", { status: 202 });
    });

  Every HTTP method is delivered to the same handler. Method, query, headers,
  and body are preserved; the handler pathname is "/". The opaque URL is not
  sender authentication — implement the provider's signature/HMAC, timestamp,
  replay, and challenge protocol. Delete revokes immediately; recreate rotates.
  Limits: 64 hooks/app, 5MiB/request. For the full contract, load the
  appato-webhooks skill.

EMAIL — opt-in, app-owned inbound and outbound mail
  Enable from the checkout:
    appato email enable both
    appato email status

  The stable address is <local>@<app>-<org>.appato.app. Send one provider message per
  recipient; Appato enforces workspace-user/claimed-domain policy, preferences,
  suppressions, and quotas before handoff.

    import { email, handleEmail } from "./_appato.js";
    await email.send({
      from: { local: "reports", name: "Reports" },
      to: ["person@example.com"],
      subject: "Report ready",
      text: "Your report is ready.",
      category: "transactional",
    });
    handleEmail("support", async (message) => {
      // Receives support+anything@<app>-<org>.appato.app as alias "support".
      await processSupportEmail(message);
    });

  Inbound attachments are lazy: await message.attachments[0].get() only when
  needed. Messages and content expire after 30 days. Use "appato email logs"
  for metadata and "appato email get <id> --body" for sensitive content.

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

LIMITS (per app; storage sizes are plan-dependent)
  128KB/value · 100MB total on the default plan — plan-dependent · watch
  <= 500 entries/prefix (paginate with list/SQL past that) · presence data
  <= 2KB · broadcast <= 32KB
  files (default plan): 25MB/file · ~1GB/app · 1000 files/app
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
// cli/src/auth.mjs

/**
 * Device-flow login, resumable by design: the pending device code is saved
 * to disk the moment it's minted, so login survives the polling process
 * dying (agent Bash timeouts, closed terminals, classifier kills). Approval
 * order doesn't matter — any later appato command completes the exchange
 * via credentials(). `--no-wait` prints the approval URL and exits
 * immediately (the agent-friendly path); `--watch` starts no login at all
 * and only observes one landing (see watchLogin).
 */
async function login(args = []) {
  if (args.includes("--watch")) return watchLogin();
  const host = DEFAULT_HOST;
  let pending = readPendingLogin();
  if (!pending || pending.host !== host) {
    const codeRes = await fetch(`${host}/api/auth/device/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "appato-cli" }),
    });
    if (!codeRes.ok) throw new Error(`device flow unavailable (${codeRes.status})`);
    // Device auth flow: out of the typed-contract scope (not an /api route).
    const code = /** @type {any} */ (await codeRes.json());
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
    emit("APPATO_LOGIN_PENDING", {
      url: pending.verify_url,
      expires_at: pending.expires_at,
    });
    return;
  }

  while (Date.now() < pending.expires_at) {
    await sleep(pending.interval * 1000);
    if (await exchangePendingLogin(pending)) {
      console.log("Logged in.");
      await whoami();
      return;
    }
  }
  rmPendingLogin();
  throw new Error("login timed out — run appato login again");
}

const IDLE_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Passive login watcher for agent harnesses — the plugin's `appato-login`
 * monitor runs `appato login --watch` in the background so the agent is
 * resumed the moment the user approves, with nothing to type.
 *
 * SILENCE IS THE CONTRACT. A monitor delivers every stdout line to the agent
 * as an interjection, so this prints ONE line per login it observes —
 * APPATO_LOGIN_COMPLETE, when the stored bearer changes to one it hasn't
 * announced — and nothing else, ever: not expiry, not access_denied, not
 * progress. Those aren't actionable mid-turn and the agent self-corrects
 * when its next appato command reports it isn't logged in. For the same
 * reason the loop never throws and never exits: a crashed watcher would
 * remove the feature with no signal at all.
 *
 * A logout and re-login in the same session therefore announces a SECOND
 * time, with the new identity. That is deliberate — do NOT latch this after
 * the first announce. An identity change mid-session is the single most
 * important thing the watcher can say, because the agent is otherwise about
 * to keep attributing pushes to the person who signed out.
 *
 * The trigger is the bearer, not the mere presence of a credentials file:
 * that token is a device-flow session and it EXPIRES, so "signed in last
 * week, token dead, sign in again" is the mainline path — keying on
 * absent→present would leave the watcher inert exactly there. `seen`
 * advances on a successful announce, and also after PROBE_ATTEMPTS failed
 * identity lookups for the same bearer: an announce whose /api/me won't
 * answer (revoked session, network partition) carries no information, and
 * without that give-up the watcher would hit the endpoint every tick for
 * the rest of the session.
 *
 * It starts no login and never announces one that was already there. Idle
 * cost is one local file read per tick; it reaches the network only while a
 * device code is outstanding, plus at most PROBE_ATTEMPTS lookups per new
 * bearer.
 */
async function watchLogin() {
  let seen = storedCredentials()?.bearer ?? null;
  let failures = 0;
  for (;;) {
    const pending = readPendingLogin();
    // Either process may win this exchange — see exchangePendingLogin.
    if (pending) await exchangePendingLogin(pending).catch(() => {});
    const cred = storedCredentials();
    if (cred && cred.bearer !== seen) {
      // `seen` records the bearer we PROBED, not whatever is on disk now: a
      // second login landing mid-probe is a separate login and gets its own
      // announce on the next tick.
      if (await announceLogin(cred)) {
        seen = cred.bearer;
        failures = 0;
      } else if (++failures >= PROBE_ATTEMPTS) {
        seen = cred.bearer;
        failures = 0;
      }
    }
    await sleep(pending ? pending.interval * 1000 : IDLE_MS);
  }
}

/** Identity lookups to spend on one new bearer before giving up on it. */
const PROBE_ATTEMPTS = 3;

/**
 * One announce attempt. True = the line was printed; false = try again.
 *
 * Deliberately total, and deliberately authenticating with credentials the
 * caller already read rather than re-entering credentials() — the one
 * helper in this file that prints to stdout, which the silence contract
 * cannot afford on any path reachable from `login --watch`. It swallows
 * everything else because a 200 from /api/me whose body has no `user.email`
 * would otherwise reject out of the loop and end the watcher for the
 * session with no signal at all.
 */
async function announceLogin(cred) {
  try {
    // Ungated on purpose — see rawApiFetch.
    const me = await fetchMe((path) => rawApiFetch(cred, path));
    if (!me) return false;
    emit("APPATO_LOGIN_COMPLETE", {
      user: me.user.email,
      orgs: me.orgs.map((o) => o.slug).join(","),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The only outcomes that consume the device code (RFC 8628 §3.5, and what
 * better-auth's device-authorization plugin actually returns). Anything
 * else — a 5xx, a proxy's HTML error page parsed to `{}`, an error string
 * we don't know — is retryable, and deleting the pending login over one
 * gateway blip would strand the user with no way to notice.
 */
const TERMINAL_LOGIN_ERRORS = new Set([
  "access_denied",
  "expired_token",
  "invalid_grant",
  "invalid_request",
  "invalid_client",
  "unauthorized_client",
]);

/**
 * How long to let a racing winner finish writing credentials.json. A fixed
 * cutoff on purpose: polling until the device code's own deadline instead
 * (the obvious "more correct" alternative) would hang a genuinely invalid
 * code for up to the full 30-minute lifetime, trading a cosmetic error
 * message for a wedged command. 300ms covers a local file write that
 * follows an already-returned HTTP response with wide margin; past it the
 * loser just prints a confusing-but-recoverable failure that its next
 * command clears.
 */
const RACE_GRACE_MS = 300;

/**
 * One token-exchange attempt. True = logged in; false = keep polling.
 * Prints nothing: the watcher shares this path and must stay silent.
 */
async function exchangePendingLogin(pending) {
  const before = storedCredentials()?.bearer;
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
    const token = /** @type {any} */ (await res.json());
    // Device-flow session token, sent as Authorization: Bearer.
    // TODO: exchange for a long-lived API key once the server supports it.
    const cred = { host: pending.host, bearer: token.access_token };
    mkdirSync(CRED_DIR, { recursive: true });
    writeFileSync(CRED_FILE, JSON.stringify(cred, null, 2), { mode: 0o600 });
    rmPendingLogin();
    return true;
  }
  const body = /** @type {any} */ (await res.json().catch(() => ({})));
  if (body.error === "authorization_pending" || body.error === "slow_down") return false;
  if (!TERMINAL_LOGIN_ERRORS.has(body.error)) return false;
  rmPendingLogin();
  // A device code is single-use, and the watcher polls alongside whatever the
  // agent runs — so the loser of that race sees a terminal error for a login
  // that in fact succeeded. A bearer that CHANGED underneath us is that race
  // and nothing else. Merely having credentials proves nothing: someone
  // signed in as A who denies a login as B still has A's, and reporting that
  // as success would announce the wrong identity for a login that failed.
  const won = () => {
    const after = storedCredentials()?.bearer;
    return Boolean(after) && after !== before;
  };
  // The winner writes credentials.json only after ITS round trip returns, so
  // the loser's error can arrive first. `invalid_grant` is the one error a
  // consumed code produces, so it's the only one worth waiting out; a denial
  // or an expiry has no winner to wait for.
  if (won()) return true;
  if (body.error === "invalid_grant") {
    await sleep(RACE_GRACE_MS);
    if (won()) return true;
  }
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

/** Usable credentials on disk, or null — the one "am I logged in?" answer. */
function storedCredentials() {
  try {
    const cred = JSON.parse(readFileSync(CRED_FILE, "utf8"));
    if (cred.bearer) return cred;
  } catch {
    // never logged in, or logged out (logout writes `{}`)
  }
  return null;
}

/** At most one pending-login completion per process — credentials() runs on
 * every request, so without this a command would re-POST an unapproved code
 * once per API call, and could even switch identity between two of them. */
let pendingSettled = false;

/**
 * Credentials for this command — completing a pending device login FIRST if
 * one exists. Order matters: the stored bearer is a session token that
 * expires, and the skill promises "run any appato command and it completes
 * the login", so a stale bearer must not shadow the identity the user just
 * approved. A hard failure falls through to whatever is stored rather than
 * breaking a command that would otherwise have worked.
 */
async function credentials() {
  const pending = pendingSettled ? null : readPendingLogin();
  if (pending) {
    pendingSettled = true;
    if (await exchangePendingLogin(pending).catch(() => false)) {
      console.log("Logged in.");
      return storedCredentials();
    }
  }
  const stored = storedCredentials();
  if (stored) return stored;
  if (pending) {
    throw new Error(
      `login pending approval — approve at ${pending.verify_url} then retry this command`,
    );
  }
  throw new Error("not logged in — run: appato login");
}

/**
 * A request authenticated with an explicit credential and NO client-side
 * version gate. Only the login watcher uses it, for both reasons: it holds
 * its own credentials (so nothing on that path can re-enter the printing
 * credentials()), and a background observer must never be silenced by a
 * minimum-version bump it can do nothing about — the plugin ships its own
 * CLI copy, which goes stale whenever the user hasn't updated the plugin.
 */
function rawApiFetch(cred, path, options = {}) {
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${cred.bearer}`);
  // Best-effort client telemetry (agent/OS/plan self-description) on every
  // request — never collides with caller headers, so set unconditionally.
  for (const [k, v] of Object.entries(clientHeaders())) headers.set(k, v);
  return fetch(`${cred.host}${path}`, { ...options, headers });
}

async function apiFetch(path, options = {}) {
  const res = await rawApiFetch(await credentials(), path, options);
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

/** The signed-in identity, or null when the server refused it. `request`
 * selects the version gate: apiFetch for commands, rawApiFetch for the
 * watcher's probe. */
async function fetchMe(request = apiFetch) {
  const res = await request("/api/me");
  if (!res.ok) return null;
  return /** @type {AuthContext} */ (await res.json());
}

async function whoami() {
  const me = await fetchMe();
  if (!me) throw new Error("unauthorized — run: appato login");
  console.log(`${me.user.email} (orgs: ${me.orgs.map((o) => o.slug).join(", ") || "none"})`);
}

/** First org membership — the default when --org isn't given. */
async function defaultOrg() {
  const me = await fetchMe();
  if (!me) throw new Error("unauthorized — run: appato login");
  const org = me.orgs[0]?.slug;
  if (!org) throw new Error("you're not in an org yet — create one at " + DEFAULT_HOST);
  return org;
}

/**
 * Best-effort browser open. A missing opener (headless Linux, minimal
 * containers, bare WSL have no xdg-open) surfaces as an asynchronous
 * `error` EVENT, not a throw — unhandled, it kills the process right after
 * the approval URL is printed and before `--no-wait` emits its machine
 * line. The listener is what actually makes this optional; the try/catch
 * only covers a synchronous spawn refusal.
 */
function tryOpen(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // same outcome — the user opens the printed URL manually
  }
}

// ---------------------------------------------------------------------------
// cli/src/anchor.mjs

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
    return /** @type {CronList} */ (await res.json()).crons.map((c) => ({
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

/** Current platform-owned email capability for manifest reflection. */
async function fetchEmailCapability(org, app, verb) {
  const res = await apiFetch(`/api/apps/${org}/${app}/email`);
  // Older Appato deployments do not expose app-owned email yet. Keeping the
  // reflection optional lets a new CLI sync/clone safely against them; once
  // the endpoint exists, its server-owned desired state is written.
  if (res.status === 404) return undefined;
  const body = /** @type {Wire<EmailCapability>} */ (await res.json());
  if (!res.ok) {
    throw apiResponseError(
      body,
      `couldn't read ${org}/${app}'s email capability (${res.status}) while ${verb}`,
    );
  }
  return body;
}

/**
 * The pushed version whose content sha matches, walking /versions pages to
 * the plan's history wall (same loop as `history --all`, stopping on a hit —
 * the common case costs one page, exactly what a single fetch did). A
 * `clone --version` checkout can sit beyond the newest page (docs/CODE.md
 * "The CLI workflow"), and matching only page one misread it as unpushed local
 * edits. Returns the version row, or null when no version matches.
 */
async function findVersionBySha(org, app, sha) {
  let cursor = 0;
  do {
    const res = await apiFetch(
      `/api/apps/${org}/${app}/versions${cursor ? `?before=${cursor}` : ""}`,
    );
    const body = /** @type {Wire<VersionsPage>} */ (await res.json());
    if (!res.ok) throw apiResponseError(body, `couldn't read versions (${res.status})`);
    const match = body.versions.find((v) => v.sha === sha);
    if (match) return match;
    cursor = body.nextBefore ?? 0;
  } while (cursor);
  return null;
}

/**
 * Rewrite appato.json's server-owned fields — `title`, `description`, and
 * `crons`, and `email` — in place, preserving every other key (org, app, …).
 * Returns true if anything changed. All four are owned by the platform: title/description
 * may have been edited in the console, and crons ride the version and are
 * pushed replace-all — so a stale local value would be stated back over the
 * real one on the next push. `crons` follows the same rule as before: the key
 * is deleted when the set is empty.
 */
function writeManifestMeta(root, { title, description, crons, email }) {
  const path = join(root, "appato.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const before = JSON.stringify(manifest);
  if (title !== undefined) manifest.title = title;
  if (description !== undefined) manifest.description = description;
  if (crons.length === 0) delete manifest.crons;
  else manifest.crons = crons;
  if (email !== undefined) {
    manifest.email = {
      inbound: Boolean(email.desired.inbound),
      outbound: Boolean(email.desired.outbound),
    };
  }
  if (JSON.stringify(manifest) === before) return false;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  return true;
}

/** Rewrite only the platform-owned email reflection after an email command. */
function writeManifestEmail(root, email) {
  const path = join(root, "appato.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.email = {
    inbound: Boolean(email.desired.inbound),
    outbound: Boolean(email.desired.outbound),
  };
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

/** The app's registry + deploy state (GET /api/apps/{org}/{app}) — carries the
 * server-owned title/description that sync refreshes into appato.json. */
async function fetchAppState(org, app) {
  const res = await apiFetch(`/api/apps/${org}/${app}`);
  const body = /** @type {Wire<AppDetail>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `couldn't read ${org}/${app} (${res.status})`);
  return body;
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
// cli/src/create.mjs

// @twin graphemes-cli-worker
function graphemes(s) {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map(
    (g) => g.segment,
  );
}

// @twin emoji-cli-worker
function isEmojiGrapheme(s) {
  return (
    /^[0-9#*]\ufe0f?\u20e3$/.test(s) || /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(s)
  );
}

/**
 * A checkout may be authored before its server app exists, or it may outlive
 * a deleted server app, or it may be copied from another checkout as a
 * starting point. Read the whole manifest so declarations and future fields
 * survive; create canonicalizes the duplicated identity/metadata fields after
 * the server accepts the new app. Returning null keeps unrelated non-empty
 * directories behind the existing refusal.
 */
function incomingManifest(dir) {
  const path = join(dir, "appato.json");
  if (!existsSync(path)) return null;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    return manifest && typeof manifest === "object" && !Array.isArray(manifest) ? manifest : null;
  } catch {
    return null;
  }
}

async function create(args) {
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-"))
      i++; // skip flag and its value
    else positionals.push(args[i]);
  }
  const slug = positionals[0];
  const title = flagValue(args, "--title");
  const description = flagValue(args, "--description");
  const orgFlag = flagValue(args, "--org");
  if (!slug || !title || !description) {
    throw new Error(
      'usage: appato create <slug> --title "Human Title" --description "One or two sentences: what the app does and who it\'s for" [--emoji "📦"] [--label "Stock"] [--org <org>]',
    );
  }
  // Icon ingredients (docs/ICONS.md v3): --emoji takes 1–2 emoji in one string
  // (grapheme-split → emoji + optional secondEmoji); --label is one punchy
  // word. The server truncates the label authoritatively (≤8 graphemes), so
  // the CLI only warns there — but a NON-emoji --emoji must fail here: the
  // server deliberately swallows a bad icon (creation must not fail over
  // cosmetics) and 201s with the placeholder, so passing it through would
  // LOOK like success. This also catches a missing value, where flagValue
  // consumes the next flag.
  const emojiArg = flagValue(args, "--emoji");
  const label = flagValue(args, "--label");
  let emoji, secondEmoji;
  if (emojiArg) {
    const parts = graphemes(emojiArg.trim());
    if (parts.length < 1 || parts.length > 2 || !parts.every(isEmojiGrapheme)) {
      throw new Error(`--emoji must be one or two emoji, got ${JSON.stringify(emojiArg)}`);
    }
    emoji = parts[0];
    secondEmoji = parts[1];
  }
  if (label && graphemes(label).length > 8) {
    console.error(`! --label is ${graphemes(label).length} graphemes; the server truncates to 8`);
  }
  const inside = findAppRoot();
  let dir;
  let localManifest = null;
  if (inside) {
    // Adopt the checkout without moving its files aside when the command
    // clearly targets this root: either its current manifest already names
    // the slug, or the directory was renamed to the requested slug after
    // being copied. From a nested source directory, "create" is still much
    // more likely to mean an accidental nested app.
    localManifest = inside === process.cwd() ? incomingManifest(inside) : null;
    if (!localManifest || (localManifest.app !== slug && basename(process.cwd()) !== slug)) {
      throw new Error(
        `already inside an appato app (${inside}) — apps don't nest; cd out and create it as a sibling`,
      );
    }
    dir = inside;
  } else {
    // Directory = bare app slug. If cwd is already named after the app (the
    // "mkdir first" habit), use it; otherwise create ./<slug>/.
    dir = basename(process.cwd()) === slug ? process.cwd() : join(process.cwd(), slug);
    if (dir !== process.cwd() && existsSync(dir) && readdirSync(dir).length > 0) {
      // An existing local manifest is a first-class create input. Preserve it
      // and the source in place; an unrelated non-empty directory remains an
      // unconditional refusal.
      localManifest = incomingManifest(dir);
      if (!localManifest) throw new Error(`./${slug}/ already exists and is not empty`);
    }
  }
  const res = await apiFetch("/api/apps", {
    method: "POST",
    body: JSON.stringify({
      slug,
      org: orgFlag,
      title,
      description,
      ...(emoji ? { emoji } : {}),
      ...(secondEmoji ? { secondEmoji } : {}),
      ...(label ? { label } : {}),
    }),
  });
  const body = /** @type {Wire<CreateApp>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `create failed (${res.status})`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "appato.json"),
    JSON.stringify(
      {
        ...(localManifest ?? {}),
        org: body.org,
        app: body.slug,
        title,
        description,
        email: { inbound: false, outbound: false },
      },
      null,
      2,
    ) + "\n",
  );
  const rel = relative(process.cwd(), dir) || ".";
  console.log(
    `Created ${body.org}/${body.slug} — "${title}" in ${
      rel === "." ? "this directory" : `./${rel}/`
    }`,
  );
  if (localManifest) {
    console.log("Preserved the existing files and appato.json declarations.");
  }
  console.log(`URL (after first push): ${body.url}`);
  emit("APPATO_CREATED", { app: `${body.org}/${body.slug}`, dir: rel, url: body.url });
}

async function clone(args) {
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-")) i++;
    else positionals.push(args[i]);
  }
  const slug = positionals[0];
  const orgFlag = flagValue(args, "--org");
  // A specific past version (v12 or 12) instead of the latest — an immutable
  // snapshot (docs/CODE.md), materialized just like any checkout.
  const versionRaw = flagValue(args, "--version");
  // A bare `--version` reads as flag-absent to flagValue — refuse it rather
  // than silently cloning the latest, the wrong checkout with a success code.
  if (args.includes("--version") && versionRaw === undefined) {
    throw new Error("--version needs a value (e.g. --version 12)");
  }
  const version = versionRaw !== undefined ? Number(String(versionRaw).replace(/^v/, "")) : null;
  if (!slug) throw new Error("usage: appato clone <slug> [dir] [--org <org>] [--version <n>]");
  if (version !== null && (!Number.isInteger(version) || version < 1)) {
    throw new Error("--version must be a positive version number (e.g. 12 or v12)");
  }
  const inside = findAppRoot();
  if (inside) {
    throw new Error(`already inside an appato app (${inside}) — apps don't nest; cd out first`);
  }
  const org = orgFlag ?? (await defaultOrg());

  // The shortcut is a latest-clone convenience only: an explicit --version
  // must still materialize (the side-by-side diff workflow, docs/CODE.md
  // "The CLI workflow") — the non-empty-dir guard below still protects the
  // target, so a duplicate destination fails loudly rather than silently.
  const existing = scanChildApps(process.cwd()).find((c) => c.org === org && c.app === slug);
  if (existing && version === null) {
    console.log(
      `${org}/${slug} is already checked out at ./${existing.dir}/ — cd in and run: appato sync`,
    );
    emit("APPATO_CLONED", { app: `${org}/${slug}`, dir: existing.dir, existing: true });
    return;
  }

  const dir = join(process.cwd(), positionals[1] || slug);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${relative(process.cwd(), dir)}/ already exists and is not empty`);
  }
  const stateRes = await apiFetch(`/api/apps/${org}/${slug}`);
  const state = /** @type {Wire<AppDetail>} */ (await stateRes.json());
  if (stateRes.status === 404) {
    throw new Error(
      `no app "${slug}" in ${org} — run \`appato status --all\` to list the org's apps`,
    );
  }
  if (!stateRes.ok) throw apiResponseError(state, `clone failed (${stateRes.status})`);

  // The file set comes from a specific VERSION's manifest (--version) or the
  // latest one; either way contents come one raw fetch per path, addressed
  // by hash (race-free against a push landing mid-clone) — no endpoint
  // returns a full file set as JSON (docs/SYNC.md S33). The cloned tree needs
  // no extra state: its filesSha equals that version's stored `sha`, so
  // status/sync/push already do the right thing (status → "behind", sync →
  // latest, push → a new version).
  const incoming = {};
  let crons;
  let clonedVersion;
  let fileCount;
  if (version !== null) {
    const fres = await apiFetch(`/api/apps/${org}/${slug}/versions/${version}/files`);
    const fbody = /** @type {Wire<VersionFiles>} */ (await fres.json());
    // A walled or missing version surfaces the server's 404 message as-is.
    if (!fres.ok) throw apiResponseError(fbody, `clone failed (${fres.status})`);
    for (const f of fbody.files) incoming[f.path] = await fetchFile(org, slug, f.path, f.sha256);
    // C1: this version's own schedules. null means the row predates schedule
    // recording ("unknown") — and the CLI wire cannot say "unknown": push
    // always states the full set, and a missing crons key is sent as [] =
    // "remove every schedule". So unknown falls back to the CURRENT
    // schedules — stating today's set is what leaves them running, the same
    // answer rollback gives (unknown → leave alone, never delete).
    crons = fbody.crons ?? (await fetchCrons(org, slug, "cloning"));
    clonedVersion = version;
    fileCount = fbody.files.length;
  } else {
    // fetchManifest's no_versions branch answers an empty set for a new app;
    // "no such app" was already excluded above.
    const man = await fetchManifest(org, slug);
    for (const [path, hash] of Object.entries(man.files)) {
      incoming[path] = await fetchFile(org, slug, path, hash);
    }
    crons = await fetchCrons(org, slug, "cloning");
    clonedVersion = state.latestVersion;
    fileCount = Object.keys(man.files).length;
  }

  const email = await fetchEmailCapability(org, slug, "cloning");
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
        ...(crons?.length ? { crons } : {}),
        ...(email
          ? {
              email: {
                inbound: email.desired.inbound,
                outbound: email.desired.outbound,
              },
            }
          : {}),
      },
      null,
      2,
    ) + "\n",
  );
  const rel = relative(process.cwd(), dir);
  console.log(
    clonedVersion > 0
      ? `Cloned ${org}/${slug} v${clonedVersion} (${fileCount} files) → ./${rel}/`
      : `Cloned ${org}/${slug} (no versions pushed yet) → ./${rel}/`,
  );
  emit("APPATO_CLONED", {
    app: `${org}/${slug}`,
    version: clonedVersion,
    dir: rel,
    url: state.url,
  });
}

// ---------------------------------------------------------------------------
// cli/src/versions.mjs

/**
 * Read one version WITHOUT checking it out (docs/CODE.md "The CLI workflow") —
 * the CLI half of the console's Code tab. No path: the version header, its
 * composition, and the file list. With a path: that file's bytes, on the same
 * `-o`/stdout posture as `files get`. Contents ride the existing /file wire
 * (SYNC.md S33) — no endpoint returns file bodies as JSON.
 */
async function show(args = []) {
  const { org, app } = appConfig();
  const json = args.includes("--json");
  const outPath = flagValue(args, "-o");
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o") i++;
    else if (a === "--json") continue;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a} — see: appato (usage)`);
    else positionals.push(a);
  }
  // `version` (v12 or 12) is optional and comes first; a lone non-numeric
  // positional is the path with the version left at "latest".
  let versionArg = null;
  let filePath;
  if (positionals[0] !== undefined && /^v?\d+$/.test(positionals[0])) {
    versionArg = Number(positionals[0].replace(/^v/, ""));
    filePath = positionals[1];
  } else {
    filePath = positionals[0];
  }

  // Metadata comes from walking /versions pages, same loop as `history --all`,
  // stopping early on a hit. When no version was named, the newest page's
  // first row IS the latest. A walled/missing version simply isn't found here
  // and the /files call below 404s with the server's message.
  let cursor = 0;
  let meta;
  do {
    const res = await apiFetch(
      `/api/apps/${org}/${app}/versions${cursor ? `?before=${cursor}` : ""}`,
    );
    const body = /** @type {Wire<VersionsPage>} */ (await res.json());
    if (!res.ok) throw apiResponseError(body, `show failed (${res.status})`);
    if (versionArg === null) {
      meta = body.versions[0];
      break;
    }
    meta = body.versions.find((v) => v.id === versionArg);
    if (meta) break;
    cursor = body.nextBefore ?? 0;
  } while (cursor);
  const id = versionArg ?? meta?.id;
  if (id == null) throw new Error(`no versions pushed yet — push one first: appato push -m "..."`);

  const res = await apiFetch(`/api/apps/${org}/${app}/versions/${id}/files`);
  const body = /** @type {Wire<VersionFiles>} */ (await res.json());
  // A walled or missing version surfaces the server's 404 message as-is.
  if (!res.ok) throw apiResponseError(body, `show failed (${res.status})`);

  if (filePath) {
    const entry = body.files.find((f) => f.path === filePath);
    if (!entry) throw new Error(`${filePath} not in v${id}`);
    // Dumping binary to a terminal is hostile — mirror `files get`.
    if (entry.binary && !outPath && process.stdout.isTTY) {
      throw new Error("won't write binary to a terminal — use -o <path> or pipe the output");
    }
    const buf = await fetchFile(org, app, filePath, entry.sha256);
    if (outPath) writeFileSync(outPath, buf);
    else process.stdout.write(buf);
    return;
  }

  if (json) {
    console.log(
      JSON.stringify({
        version: id,
        ...(meta?.message !== undefined ? { message: meta.message } : {}),
        ...(meta?.stats !== undefined ? { stats: meta.stats } : {}),
        files: body.files,
        crons: body.crons,
      }),
    );
    return;
  }

  const s = meta?.stats;
  console.log(`v${id}  ${meta ? ago(meta.createdAt) : ""}  ${meta?.message || "(no message)"}`);
  // Attribution (docs/CODE.md V9): who drove this push, when the server
  // recorded it — agent always, model when present. Absent for restores and
  // pre-feature versions.
  if (meta?.client) {
    console.log(`  via ${meta.client.agent}${meta.client.model ? ` · ${meta.client.model}` : ""}`);
  }
  if (s) {
    // Same "(partial)" rule as history: capped stats total only the first
    // STATS_MAX_CHANGED files, so the line is a floor.
    console.log(
      `  ${s.filesChanged} file${s.filesChanged === 1 ? "" : "s"} +${s.added} −${s.removed}${s.truncated ? " (partial)" : ""}`,
    );
    console.log(`  ${composition(s, body.files)}`);
  }
  // The version's own schedules (docs/CRON.md C1) — null/empty prints nothing.
  if (body.crons?.length) {
    for (const c of body.crons) {
      console.log(`  schedule: ${c.name}  ${c.schedule}${c.tz ? ` ${c.tz}` : ""}`);
    }
  }
  for (const f of body.files) {
    console.log(`${f.path}  ${formatBytes(f.bytes)}${f.binary ? "  [binary]" : ""}`);
  }
  emit("APPATO_SHOW", { app: `${org}/${app}`, version: id, files: body.files.length });
}

/**
 * A version's makeup for the show header — total source lines, each language's
 * share of them (from stats.loc), and asset weight (stats.assetBytes, with the
 * asset count taken from the file listing's binary flags). The console renders
 * the same three facts as a composition header (docs/CODE.md "The view").
 */
function composition(stats, files) {
  const loc = stats.loc ?? {};
  const total = Object.values(loc).reduce((a, b) => a + b, 0);
  const parts = [`${commas(total)} lines`];
  // Zero-line buckets (empty files) would print "NaN%" at total 0 and a
  // useless "0%" otherwise — skip them.
  for (const [lang, n] of Object.entries(loc).sort((a, b) => b[1] - a[1])) {
    if (n > 0) parts.push(`${lang} ${Math.round((n / total) * 100)}%`);
  }
  const assets = files.filter((f) => f.binary).length;
  if (assets > 0) {
    parts.push(`${assets} asset${assets === 1 ? "" : "s"}, ${formatBytes(stats.assetBytes)}`);
  }
  return parts.join(" · ");
}

/** Thousands separators, locale-independent (deterministic across machines). */
function commas(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
    const body = /** @type {Wire<VersionsPage>} */ (await res.json());
    if (!res.ok) throw apiResponseError(body, `history failed (${res.status})`);
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
    // Diffstat sub-line when the server stamped stats (docs/CODE.md V2);
    // skipped for null/undefined so older servers/versions render unchanged.
    // "(partial)" mirrors the console: capped stats cover only the first
    // STATS_MAX_CHANGED files, so the line totals are a floor, not exact.
    const s = v.stats;
    const diffstat = s
      ? `  ${s.filesChanged} file${s.filesChanged === 1 ? "" : "s"} +${s.added} −${s.removed}${s.truncated ? " (partial)" : ""}`
      : "";
    console.log(`${flag} v${v.id}  ${ago(v.createdAt)}  ${v.message || "(no message)"}${diffstat}`);
    if (v.details) console.log(`     ${v.details.replace(/\n/g, "\n     ")}`);
  }
  // Rollback accepts any version id, so older targets work either way —
  // this is a discovery hint only.
  if (truncated) {
    console.log(`… older versions exist — run: appato history --all`);
  }
}

async function rollback(args = []) {
  const { org, app } = appConfig();
  const raw = args.find((a) => /^v?\d+$/.test(a));
  const target = raw ? Number(raw.replace(/^v/, "")) : NaN;
  if (!Number.isInteger(target) || target < 1) {
    throw new Error("usage: appato rollback <version> — pick one from appato history");
  }
  const res = await apiFetch(`/api/apps/${org}/${app}/rollback`, {
    method: "POST",
    body: JSON.stringify({ version: target }),
  });
  const body = /** @type {Wire<Rollback>} */ (await res.json());
  if (res.status === 422) {
    console.error(
      `✗ created v${body.version} from v${target}, but deploy FAILED:\n  ${body.deployError}`,
    );
    console.error("The previously deployed version keeps serving.");
    emit("APPATO_DEPLOY_FAILED", {
      app: `${org}/${app}`,
      version: body.version,
      error: body.deployError,
    });
    process.exit(2);
  }
  if (!res.ok) throw apiResponseError(body, `rollback failed (${res.status})`);
  // `restored` is the version that authored the content — it differs from
  // the target when the target was itself a rollback (server resolves to
  // the origin so rollback chains never form).
  const restored = body.restored ?? target;
  const what = restored === target ? `v${target}` : `v${restored}'s code, via v${target}`;
  console.log(`✓ rolled back — v${body.version} now live (restored ${what}) → ${body.url}`);
  console.log(`Local files are now behind the new version; run: appato sync`);
  emit("APPATO_ROLLED_BACK", {
    app: `${org}/${app}`,
    version: body.version,
    restored,
    url: body.url,
  });
}

// ---------------------------------------------------------------------------
// cli/src/pushsync.mjs

// The final APPATO_* line of push/sync/status is a stable machine contract for
// driving agents (see SKILL.md): space-separated key=value pairs, values
// JSON-encoded when they may contain spaces. Don't reword these lines.
async function push(args = []) {
  const { org, app, title, description, crons, root } = appConfig();
  const message = flagValue(args, "-m") ?? flagValue(args, "--message");
  const details = flagValue(args, "--details") ?? "";
  // Self-reported model id (telemetry only): folded into the client header, so
  // it must be set before any request the header rides on.
  setSelfReportedModel(flagValue(args, "--model"));
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
  let res = await pushRequest(
    org,
    app,
    files,
    binHashes,
    deltaAgainst(man, files, binHashes),
    meta,
  );
  // The push wire (delta/base reconstruction, blob refs) is out of the typed
  // /api contract scope — SYNC.md owns its shape.
  let body = /** @type {any} */ (await res.json());
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
    emit("APPATO_DEPLOY_FAILED", {
      app: `${org}/${app}`,
      version: body.version,
      sha,
      error: body.deployError,
    });
    process.exit(2);
  }
  if (!res.ok) throw apiResponseError(body, `push failed (${res.status})`);
  console.log(`✓ deployed v${body.version} → ${body.url}`);
  emit("APPATO_DEPLOYED", {
    app: `${org}/${app}`,
    version: body.version,
    sha,
    url: body.url,
  });
}

async function sync(args = []) {
  const {
    org,
    app,
    root,
    title: localTitle,
    description: localDescription,
    crons: localCrons,
  } = appConfig();
  const force = args.includes("--force");
  // The manifest, not the files: {path: sha256} is a few hundred bytes
  // against the whole app, and it is enough to decide everything below.
  // Content is fetched per differing path, addressed by hash so a push
  // landing mid-sync cannot swap the bytes underneath us.
  const man = await fetchManifest(org, app);
  // Refresh every server-owned appato.json field (title, description,
  // schedules) BEFORE the file comparison and regardless of its outcome.
  // None of these ride the file hashes: title/description live in the
  // registry (and may have been edited in the console), and schedules ride
  // the version. Without this a sync could report "up to date" while the
  // local copy held stale values, and the next push would state them back
  // over the real ones. Crons first, so an unreadable set aborts (a missing
  // manifest would push "delete every schedule").
  const crons = await fetchCrons(org, app, "syncing");
  const state = await fetchAppState(org, app);
  // What actually differs, computed the same way writeManifestMeta writes:
  // a field only counts when the platform stated it and it differs from the
  // local value, so the message never claims a change that wasn't made.
  const metaChanged = [];
  if (state.title !== undefined && state.title !== localTitle) metaChanged.push("title");
  if (state.description !== undefined && state.description !== localDescription) {
    metaChanged.push("description");
  }
  if (JSON.stringify(crons) !== JSON.stringify(localCrons ?? [])) metaChanged.push("schedules");
  const email = await fetchEmailCapability(org, app, "syncing");
  writeManifestMeta(root, { title: state.title, description: state.description, crons, email });
  if (metaChanged.length) {
    console.log(`✓ appato.json updated from the platform (${metaChanged.join(", ")})`);
  }
  const local = collectFiles(root);
  const localBinHashes = binaryHashes(local.binary);
  const localSha = localSetSha(local.files, localBinHashes);
  const localHashes = { ...hashFiles(local.files), ...localBinHashes };
  const changed = manifestDiff(localHashes, man.files);

  if (changed.length === 0) {
    console.log(`Already up to date (v${man.version}).`);
    emit("APPATO_SYNCED", {
      app: `${org}/${app}`,
      version: man.version,
      changed: false,
      sha: localSha,
    });
    return;
  }

  if (!force) {
    // Safe to overwrite only if the local copy is exactly some pushed version
    // (then nothing would be lost — it's all in history). Otherwise there are
    // unpushed local edits and sync must not discard them.
    const match = await findVersionBySha(org, app, localSha);
    if (!match && Object.keys(localHashes).length > 0) {
      console.error(
        `✗ local files don't match any pushed version — syncing would discard changes in:`,
      );
      for (const p of changed) console.error(`    ${p}`);
      console.error(`Push them first (appato push -m "...") or discard them: appato sync --force`);
      emit("APPATO_SYNC_BLOCKED", {
        app: `${org}/${app}`,
        latest_version: man.version,
        local_sha: localSha,
      });
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
  emit("APPATO_SYNCED", {
    app: `${org}/${app}`,
    version: man.version,
    changed: true,
    files: changed.length,
    sha: syncedSha,
  });
}

// ---------------------------------------------------------------------------
// cli/src/lifecycle.mjs

/**
 * Pause an app: take it offline (dispatch script removed, all versions and
 * data kept but frozen) — docs/LIFECYCLE.md. Reversible with `appato resume`.
 * Slug resolution is the same as push (the local appato.json's org/app).
 */
async function pause() {
  const { org, app } = appConfig();
  const res = await apiFetch(`/api/apps/${org}/${app}/pause`, { method: "POST" });
  const body = /** @type {Wire<AppPaused>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `pause failed (${res.status})`);
  console.log(`✓ paused ${org}/${app} — offline, data frozen. Resume with: appato resume`);
  emit("APPATO_PAUSED", { app: `${org}/${app}` });
}

/** Resume a paused app: redeploy the last deployed version and unfreeze. */
async function resume() {
  const { org, app } = appConfig();
  const res = await apiFetch(`/api/apps/${org}/${app}/resume`, { method: "POST" });
  // 200 body is a union (active with/without a redeployed version); the fields
  // read below live on one arm only, so a plain `any` avoids a spurious
  // union-narrowing error — deliberately looser per the spec's escape hatch.
  const body = /** @type {any} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `resume failed (${res.status})`);
  // The API answers 200 with the redeploy's outcome in the body: a failed
  // redeploy means the app is active but still offline (no script, schedules
  // suspended) — that is not a resume, so no APPATO_RESUMED.
  if (body.deployStatus === "error") {
    throw new Error(
      `resume failed: the redeploy errored and ${org}/${app} is still offline. Fix and \`appato push\`, or retry \`appato resume\`.`,
    );
  }
  console.log(`✓ resumed ${org}/${app} → ${body.url ?? ""}`);
  emit("APPATO_RESUMED", { app: `${org}/${app}`, url: body.url });
}

/**
 * Move an app to the trash (docs/LIFECYCLE.md D3): offline + frozen like pause,
 * but on a countdown to permanent deletion — restorable with `appato restore`
 * until then. Slug resolution is the same as push (the local appato.json).
 */
async function trash() {
  const { org, app } = appConfig();
  const res = await apiFetch(`/api/apps/${org}/${app}/trash`, { method: "POST" });
  const body = /** @type {Wire<AppTrashed>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `trash failed (${res.status})`);
  console.log(`✓ moved ${org}/${app} to the trash — offline, frozen. Restore with: appato restore`);
  emit("APPATO_TRASHED", { app: `${org}/${app}`, deletes_at: body.deletesAt });
}

/** Restore a trashed app: back to active, redeploying the last version (D12). */
async function restore() {
  const { org, app } = appConfig();
  const res = await apiFetch(`/api/apps/${org}/${app}/restore`, { method: "POST" });
  // 200 body is the same active-with/without-version union as resume — `any`
  // for the same reason (fields read live on one arm only).
  const body = /** @type {any} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `restore failed (${res.status})`);
  // A failed redeploy leaves the app active-but-offline (same shape as resume) —
  // that is not a clean restore, so no APPATO_RESTORED.
  if (body.deployStatus === "error") {
    throw new Error(
      `restore failed: the redeploy errored and ${org}/${app} is active but still offline. Fix and \`appato push\`.`,
    );
  }
  console.log(`✓ restored ${org}/${app} → ${body.url ?? ""}`);
  emit("APPATO_RESTORED", { app: `${org}/${app}`, url: body.url });
}

/**
 * Delete a trashed app forever (docs/LIFECYCLE.md D5) — irreversible, so it
 * REFUSES without `--force` (no interactive prompt: the agent runs
 * non-interactively). Takes an explicit slug because a corpse has no local
 * checkout; `--org` picks the workspace (default: your first).
 */
async function deleteForever(args = []) {
  // Positionals skip each option AND its value, exactly like create(): a bare
  // `args.find(a => !a.startsWith("-"))` picked the FIRST non-dash token, so
  // `appato delete --org acme tracker --force` selected "acme" (the --org
  // VALUE) as the slug — a wrong-target on an irreversible command.
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-"))
      i++; // skip flag and its value
    else positionals.push(args[i]);
  }
  const slug = positionals[0];
  if (!slug) {
    throw new Error("usage: appato delete <slug> --force [--org <org>]");
  }
  if (!args.includes("--force")) {
    throw new Error(
      `refusing to delete "${slug}" forever without --force. This destroys all code, data, files, and logs and cannot be undone. Re-run with: appato delete ${slug} --force`,
    );
  }
  const org = flagValue(args, "--org") || (await defaultOrg());
  const res = await apiFetch(`/api/apps/${org}/${slug}`, { method: "DELETE" });
  const body = /** @type {Wire<AppDeleted>} */ (await res.json().catch(() => ({})));
  if (!res.ok) throw apiResponseError(body, `delete failed (${res.status})`);
  console.log(`✓ deleted ${org}/${slug} forever`);
  emit("APPATO_DELETED", { app: `${org}/${slug}` });
}

// ---------------------------------------------------------------------------
// cli/src/cron.mjs

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
      throw new Error(
        `unknown cron command "${sub}" — use: list | run <name> | pause <name> | resume <name>`,
      );
    }
    if (!name) throw new Error(`usage: appato cron ${sub} <name>`);
    const res = await apiFetch(`/api/apps/${org}/${app}/crons/${name}/${sub}`, { method: "POST" });
    // run yields a CronRun; pause/resume only read `error` here, which Wire adds.
    const body = /** @type {Wire<CronRun>} */ (await res.json());
    if (res.status === 404) throw apiResponseError(body, `no cron "${name}" in appato.json`);
    if (sub === "run") {
      const ok = res.ok && body.status === "ok";
      const detail = body.error ? ` — ${body.error}` : "";
      console.log(
        `${ok ? "✓" : "✗"} ran "${name}" (${body.status}, ${body.durationMs}ms)${detail}`,
      );
      // What the handler returned. The point of a test run is seeing what the
      // job actually DID, not just that it exited 2xx.
      if (body.output) {
        for (const line of String(body.output).split("\n")) console.log(`     ${line}`);
      }
      emit("APPATO_CRON_RUN", {
        app: `${org}/${app}`,
        name,
        status: body.status,
        http: body.httpStatus,
        duration_ms: body.durationMs,
        error: body.error,
        output: body.output,
      });
      if (!ok) process.exit(2);
      return;
    }
    if (!res.ok) throw apiResponseError(body, `cron ${sub} failed (${res.status})`);
    console.log(`✓ ${sub}d "${name}"`);
    emit(sub === "pause" ? "APPATO_CRON_PAUSED" : "APPATO_CRON_RESUMED", {
      app: `${org}/${app}`,
      name,
    });
    return;
  }

  const res = await apiFetch(`/api/apps/${org}/${app}/crons`);
  const body = /** @type {Wire<CronList>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `cron list failed (${res.status})`);
  if (args.includes("--json")) {
    console.log(JSON.stringify(body));
    return;
  }
  if (body.crons.length === 0) {
    console.log(`No schedules. Add a "crons" array to appato.json and push:`);
    console.log(
      `  "crons": [{ "name": "friday-reminder", "schedule": "0 9 * * 5", "tz": "America/Chicago" }]`,
    );
    console.log(`Your app handles POST /cron/<name> (see: appato sdk).`);
  } else {
    if (body.suspended) console.log(`⚠ app is paused — no schedule runs until it's resumed`);
    for (const c of body.crons) {
      const when = c.paused
        ? c.pausedBy === "auto"
          ? `PAUSED after ${c.consecutiveFailures} failures`
          : "paused"
        : c.nextAt
          ? `next ${until(c.nextAt)}`
          : "not scheduled";
      const last = c.lastRun ? `  last ${c.lastRun.status} ${ago(c.lastRun.startedAt)}` : "";
      console.log(
        `${c.paused ? "⏸" : "●"} ${c.name}  ${c.schedule}${c.tz ? ` ${c.tz}` : " UTC"}  ${when}${last}`,
      );
      if (c.lastRun?.error) console.log(`     ${c.lastRun.error}`);
    }
  }
  emit("APPATO_CRONS", {
    app: `${org}/${app}`,
    count: body.crons.length,
    suspended: body.suspended,
  });
  for (const c of body.crons) {
    emit("APPATO_CRON", {
      name: c.name,
      schedule: c.schedule,
      tz: c.tz,
      paused: c.paused,
      paused_by: c.pausedBy,
      next_at: c.nextAt,
      failures: c.consecutiveFailures,
      last_status: c.lastRun?.status,
    });
  }
}

// ---------------------------------------------------------------------------
// cli/src/data.mjs

/**
 * The Data tool (docs/TOOLS.md "Data"): the operator view over an app's
 * KV + SQL. Scopes are bypassed by design — the builder seat pays for it —
 * and every mutation (and read of someone else's `mine` data) is attributed
 * and logged to the app's timeline server-side. The APPATO_* lines are part
 * of the machine contract (see push above).
 */
async function data(args = []) {
  const { org, app } = appConfig();
  // Positionals: only the KNOWN flags are flags — everything else is a
  // value, including "-" (read stdin), "-1" (a negative number to set) and
  // any other dash-leading string. Guessing from the dash would eat values.
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--write" || a === "--json") continue;
    if (a === "--scope" || a === "--user") i++;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a} — see: appato (usage)`);
    else positionals.push(a);
  }
  const [sub, ...rest] = positionals;

  if (!sub) return dataOverviewCmd(org, app);

  if (sub === "sql") {
    const write = args.includes("--write");
    const json = args.includes("--json");
    if (rest[0] !== undefined) return runDataSql(org, app, rest[0], write, json);
    if (!process.stdin.isTTY) {
      // Piped: all of stdin is ONE statement (never split on semicolons —
      // the server takes exactly one; a trailing ; is muscle memory).
      const piped = readFileSync(0, "utf8").trim().replace(/;$/, "");
      if (!piped) throw new Error("no SQL statement on stdin");
      return runDataSql(org, app, piped, write, json);
    }
    return dataSqlRepl(org, app);
  }

  if (!["ls", "get", "set", "rm"].includes(sub)) {
    throw new Error(
      `unknown data command "${sub}" — use: ls | get | set | rm | sql (bare \`appato data\` shows the overview)`,
    );
  }

  const scope = flagValue(args, "--scope") ?? "shared";
  if (!["shared", "mine", "readonly", "internal"].includes(scope)) {
    throw new Error("--scope must be one of: shared, mine, readonly, internal");
  }
  let user = flagValue(args, "--user");
  if (scope === "mine" && !user) {
    throw new Error("--scope mine needs --user <id|email> — whose personal data?");
  }
  if (scope !== "mine" && user) {
    throw new Error("--user only applies with --scope mine (other scopes aren't per-person)");
  }
  if (user?.includes("@")) user = await resolveDataUser(org, app, user);

  if (sub === "ls") return dataLs(org, app, rest[0] ?? "", scope, user);
  const key = rest[0];
  if (!key) {
    throw new Error(
      `usage: appato data ${sub} <key>${sub === "set" ? " <value|->" : ""} [--scope shared|readonly|internal|mine] [--user <id|email>]`,
    );
  }
  if (sub === "get") return dataGet(org, app, key, scope, user);
  if (sub === "rm") return dataRm(org, app, key, scope, user);
  if (rest[1] === undefined) {
    throw new Error(
      'usage: appato data set <key> <value|-> — value is JSON (or a plain string); "-" reads stdin',
    );
  }
  return dataSet(org, app, key, rest[1], scope, user);
}

/** GET /data — shared by the overview command, email→id resolution, and the
 * REPL's .tables/.schema. */
async function fetchDataOverview(org, app) {
  const res = await apiFetch(`/api/apps/${org}/${app}/data`);
  const body = /** @type {Wire<DataOverview>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `data overview failed (${res.status})`);
  return body;
}

/** `--user someone@co` → their id, via the overview's `mine` owner list.
 * @twin cli-resolve-user */
async function resolveDataUser(org, app, email) {
  const { users } = await fetchDataOverview(org, app);
  const match = users.find((u) => u.email === email);
  if (match) return match.id;
  const known = users.map((u) => u.email).filter(Boolean);
  throw new Error(
    `no personal data stored for ${email}` +
      (known.length
        ? ` — people with data: ${known.join(", ")}`
        : " — nobody has personal data in this app yet"),
  );
}

async function dataOverviewCmd(org, app) {
  const o = await fetchDataOverview(org, app);
  console.log(`${org}/${app} data — ${formatBytes(o.dbSize)} of ${formatBytes(o.dbLimit)} used`);
  if (o.tables.length > 0) {
    console.log(`tables:`);
    for (const t of o.tables) {
      console.log(`  ${t.name}  ${t.rows} row(s)  (${t.columns.map((c) => c.name).join(", ")})`);
    }
  }
  console.log(`kv keys:`);
  console.log(`  shared    ${o.kv.shared} — every member reads + writes`);
  console.log(`  readonly  ${o.kv.readonly} — the app's server writes; browsers only read`);
  console.log(`  internal  ${o.kv.internal} — server-only; browsers never see it`);
  if (o.users.length > 0) {
    console.log(`personal (mine) data:`);
    for (const u of o.users) {
      console.log(`  ${u.name}${u.email ? ` <${u.email}>` : ""}  ${u.keys} key(s)`);
    }
  }
  if (o.sessions.length > 0) {
    console.log(
      `live now: ${o.sessions.map((s) => `${s.name} (${s.sockets} tab${s.sockets === 1 ? "" : "s"})`).join(", ")}`,
    );
  }
  emit("APPATO_DATA", {
    app: `${org}/${app}`,
    tables: o.tables.length,
    kv_shared: o.kv.shared,
    kv_readonly: o.kv.readonly,
    kv_internal: o.kv.internal,
    people: o.users.length,
    size_bytes: o.dbSize,
    sessions: o.sessions.length,
  });
  for (const t of o.tables) {
    emit("APPATO_TABLE", {
      name: t.name,
      rows: t.rows,
      cols: t.columns.map((c) => c.name).join(","),
    });
  }
}

async function dataLs(org, app, prefix, scope, user) {
  const params = new URLSearchParams({ scope });
  if (user) params.set("user", user);
  if (prefix) params.set("prefix", prefix);
  const res = await apiFetch(`/api/apps/${org}/${app}/data/kv?${params}`);
  const body = /** @type {Wire<DataKvPage>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `data ls failed (${res.status})`);
  for (const e of body.entries) {
    console.log(`${e.key}  ${e.by ? e.by.name : "app server"}  ${ago(e.at)}`);
  }
  if (body.entries.length === 0) {
    console.log(`No keys in ${scope}${prefix ? ` under "${prefix}"` : ""}.`);
  }
  if (body.truncated) {
    console.log(`… more keys exist — narrow with a prefix: appato data ls <prefix>`);
  }
  emit("APPATO_KEYS", {
    app: `${org}/${app}`,
    scope,
    user,
    prefix,
    count: body.entries.length,
    truncated: body.truncated,
  });
  for (const e of body.entries) {
    emit("APPATO_KEY", { key: e.key, by: e.by ? e.by.name : null, at: e.at });
  }
}

/** There is no single-key read on the wire — the list endpoint with the key
 * as its own prefix answers it in one call. */
async function dataGet(org, app, key, scope, user) {
  const params = new URLSearchParams({ scope, prefix: key });
  if (user) params.set("user", user);
  const res = await apiFetch(`/api/apps/${org}/${app}/data/kv?${params}`);
  const body = /** @type {Wire<DataKvPage>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `data get failed (${res.status})`);
  const hit = body.entries.find((e) => e.key === key);
  if (!hit) {
    console.error(`no key ${JSON.stringify(key)} in ${scope}`);
    emit("APPATO_KV", { app: `${org}/${app}`, scope, key, found: false });
    process.exit(1);
  }
  console.log(JSON.stringify(hit.value, null, 2));
  emit("APPATO_KV", {
    app: `${org}/${app}`,
    scope,
    key,
    found: true,
    by: hit.by ? hit.by.name : null,
    at: hit.at,
  });
}

async function dataSet(org, app, key, rawValue, scope, user) {
  const raw = rawValue === "-" ? readFileSync(0, "utf8") : rawValue;
  // JSON when it parses, otherwise the literal string — so both
  // `set greeting hello` and `set config '{"x":1}'` do the obvious thing.
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  const res = await apiFetch(`/api/apps/${org}/${app}/data/kv`, {
    method: "PUT",
    body: JSON.stringify({ scope, ...(user ? { user } : {}), key, value }),
  });
  const body = /** @type {Wire<DataKvPut>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `data set failed (${res.status})`);
  console.log(`✓ set ${scope}:${key}`);
  emit("APPATO_KV_SET", { app: `${org}/${app}`, scope, key });
}

async function dataRm(org, app, key, scope, user) {
  const params = new URLSearchParams({ scope, key });
  if (user) params.set("user", user);
  const res = await apiFetch(`/api/apps/${org}/${app}/data/kv?${params}`, { method: "DELETE" });
  const body = /** @type {Wire<DataKvDelete>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `data rm failed (${res.status})`);
  console.log(body.deleted ? `✓ deleted ${scope}:${key}` : `${scope}:${key} did not exist`);
  emit("APPATO_KV_DELETED", {
    app: `${org}/${app}`,
    scope,
    key,
    existed: body.deleted,
  });
}

/** POST /data/sql — one statement. Any refusal (e.g. the 409 "this statement
 * writes — re-run with --write") throws, which is the existing error style. */
async function postDataSql(org, app, query, write) {
  const res = await apiFetch(`/api/apps/${org}/${app}/data/sql`, {
    method: "POST",
    body: JSON.stringify({ query, write }),
  });
  const body = /** @type {Wire<SqlResult>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `sql failed (${res.status})`);
  return body;
}

async function runDataSql(org, app, stmt, write, json) {
  const result = await postDataSql(org, app, stmt, write);
  if (json) {
    console.log(JSON.stringify(result));
  } else {
    printSqlRows(result.rows);
    console.log(sqlCounts(result));
  }
  emit("APPATO_SQL", {
    app: `${org}/${app}`,
    rows: result.rows.length,
    rows_read: result.rowsRead,
    rows_written: result.rowsWritten,
    truncated: result.truncated,
    write,
  });
}

/** Column-aligned rows, sqlite3-column-mode-style: NULL spelled out, cell
 * display capped at 40 chars (the full value is one `data get` away). */
function printSqlRows(rows) {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    if (v === null || v === undefined) return "NULL";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 40 ? s.slice(0, 39) + "…" : s;
  };
  const grid = rows.map((r) => cols.map((c) => cell(r[c])));
  const widths = cols.map((c, i) => Math.max(c.length, ...grid.map((g) => g[i].length)));
  console.log(cols.map((c, i) => c.padEnd(widths[i])).join("  "));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const g of grid)
    console.log(
      g
        .map((s, i) => s.padEnd(widths[i]))
        .join("  ")
        .trimEnd(),
    );
}

function sqlCounts(result) {
  return `${result.rows.length} row(s) — ${result.rowsRead} read, ${result.rowsWritten} written${result.truncated ? " (truncated to 500 rows)" : ""}`;
}

/**
 * Interactive SQL (TTY only — piped stdin is handled in data()). Statements
 * buffer until a line ends with `;`, sqlite3-style; dot-commands are single
 * lines and borrow sqlite3's names so muscle memory transfers. Write mode
 * is OFF until `.write on` — errors print and the loop continues.
 */
async function dataSqlRepl(org, app) {
  let write = false;
  let buffer = "";
  console.log(
    `SQL on ${org}/${app} — read-only (.write on to allow writes; .help for commands; end statements with ;)`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => {
    rl.setPrompt(buffer ? "   ...> " : `${org}/${app}> `);
    rl.prompt();
  };
  prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!buffer && trimmed === "") {
      prompt();
      continue;
    }
    if (!buffer && trimmed.startsWith(".")) {
      if (trimmed === ".quit" || trimmed === ".exit") break;
      try {
        write = await dataDotCommand(trimmed, org, app, write);
      } catch (err) {
        console.error(`error: ${err.message}`);
      }
      prompt();
      continue;
    }
    buffer += (buffer ? "\n" : "") + line;
    if (!buffer.trim().endsWith(";")) {
      prompt();
      continue;
    }
    const stmt = buffer.trim().replace(/;$/, "");
    buffer = "";
    try {
      const result = await postDataSql(org, app, stmt, write);
      printSqlRows(result.rows);
      console.log(sqlCounts(result));
    } catch (err) {
      console.error(`error: ${err.message}`);
    }
    prompt();
  }
  rl.close();
}

/** The REPL's dot-commands (`.quit`/`.exit` are handled by the caller).
 * Returns the write mode for subsequent statements. */
async function dataDotCommand(cmd, org, app, write) {
  const [name, arg] = cmd.split(/\s+/);
  if (name === ".help") {
    console.log(`.tables            list the app's SQL tables
.schema [table]    show CREATE statements (all tables, or one)
.write on|off      allow/refuse writing statements (bare .write: show mode)
.quit / .exit      leave (Ctrl-D works too)
Anything else is SQL — end each statement with ;`);
  } else if (name === ".tables") {
    const { tables } = await fetchDataOverview(org, app);
    if (tables.length === 0) console.log("(no tables)");
    for (const t of tables) console.log(t.name);
  } else if (name === ".schema") {
    const { tables } = await fetchDataOverview(org, app);
    if (arg && !tables.some((t) => t.name === arg)) console.error(`no table "${arg}"`);
    else if (tables.length === 0) console.log("(no tables)");
    else for (const t of tables) if (!arg || t.name === arg) console.log(t.sql);
  } else if (name === ".write") {
    if (!arg) console.log(`write mode is ${write ? "on" : "off"}`);
    else if (arg === "on") {
      write = true;
      console.log("⚠ write mode ON — statements now change the app's live data");
    } else if (arg === "off") {
      write = false;
      console.log("write mode off");
    } else console.error("usage: .write on|off");
  } else {
    console.error(`unknown command ${name} — .help lists commands`);
  }
  return write;
}

// ---------------------------------------------------------------------------
// cli/src/files.mjs

/**
 * The Files tool (docs/FILES.md, docs/TOOLS.md "The Data tool"): the operator
 * view over the app's uploaded blobs — the file counterpart to `appato data`. Scopes
 * are bypassed the same way (the builder seat pays for it), and every upload,
 * delete, and read of someone else's `mine` files is attributed and logged to
 * the app's timeline server-side. The APPATO_* lines are part of the machine
 * contract (see push above).
 */
async function files(args = []) {
  const { org, app } = appConfig();
  // Positionals: only the KNOWN flags are flags — everything else is a value
  // (a key or a path may legitimately dash-lead). Mirrors data()'s parser.
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--scope" || a === "--user" || a === "--type" || a === "-o") i++;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a} — see: appato (usage)`);
    else positionals.push(a);
  }
  const [sub, ...rest] = positionals;

  if (!sub) return filesOverviewCmd(org, app);

  if (!["ls", "get", "put", "rm"].includes(sub)) {
    throw new Error(
      `unknown files command "${sub}" — use: ls | get | put | rm (bare \`appato files\` shows the overview)`,
    );
  }

  const scope = flagValue(args, "--scope") ?? "shared";
  if (!["shared", "mine", "readonly", "internal"].includes(scope)) {
    throw new Error("--scope must be one of: shared, mine, readonly, internal");
  }
  let user = flagValue(args, "--user");
  if (scope === "mine" && !user) {
    throw new Error("--scope mine needs --user <id|email> — whose personal files?");
  }
  if (scope !== "mine" && user) {
    throw new Error("--user only applies with --scope mine (other scopes aren't per-person)");
  }
  if (user?.includes("@")) user = await resolveFilesUser(org, app, user);

  if (sub === "ls") return filesLs(org, app, rest[0] ?? "", scope, user);
  if (sub === "put") {
    if (!rest[0]) {
      throw new Error(
        "usage: appato files put <path> [<key>] [--scope shared|readonly|internal|mine] [--user <id|email>] [--type <mime>]",
      );
    }
    return filesPut(org, app, rest[0], rest[1], scope, user, flagValue(args, "--type"));
  }
  const key = rest[0];
  if (!key) {
    throw new Error(
      `usage: appato files ${sub} <key> [--scope shared|readonly|internal|mine] [--user <id|email>]`,
    );
  }
  if (sub === "get") return filesGet(org, app, key, scope, user, flagValue(args, "-o"));
  return filesRm(org, app, key, scope, user);
}

/** GET /files — shared by the overview command and email→id resolution. */
async function fetchFilesOverview(org, app) {
  const res = await apiFetch(`/api/apps/${org}/${app}/files`);
  const body = /** @type {Wire<FilesOverview>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `files overview failed (${res.status})`);
  return body;
}

/** `--user someone@co` → their id, via the overview's `mine` owner list.
 * @twin cli-resolve-user */
async function resolveFilesUser(org, app, email) {
  const { users } = await fetchFilesOverview(org, app);
  const match = users.find((u) => u.email === email);
  if (match) return match.id;
  const known = users.map((u) => u.email).filter(Boolean);
  throw new Error(
    `no personal files stored for ${email}` +
      (known.length
        ? ` — people with files: ${known.join(", ")}`
        : " — nobody has personal files in this app yet"),
  );
}

async function filesOverviewCmd(org, app) {
  const o = await fetchFilesOverview(org, app);
  console.log(`${org}/${app} files:`);
  console.log(
    `  shared    ${o.scopes.shared.count} file(s), ${formatBytes(o.scopes.shared.bytes)} — every member reads + writes`,
  );
  console.log(
    `  readonly  ${o.scopes.readonly.count} file(s), ${formatBytes(o.scopes.readonly.bytes)} — the app's server writes; browsers only read`,
  );
  console.log(
    `  internal  ${o.scopes.internal.count} file(s), ${formatBytes(o.scopes.internal.bytes)} — server-only; browsers never see it`,
  );
  if (o.users.length > 0) {
    console.log(`personal (mine) files:`);
    for (const u of o.users) {
      console.log(
        `  ${u.name}${u.email ? ` <${u.email}>` : ""}  ${u.count} file(s), ${formatBytes(u.bytes)}`,
      );
    }
  }
  console.log(
    `quota: ${o.totalCount} of ${o.maxCount} files · ${formatBytes(o.totalBytes)} of ${formatBytes(o.maxBytes)}`,
  );
  emit("APPATO_FILES", {
    app: `${org}/${app}`,
    shared: o.scopes.shared.count,
    readonly: o.scopes.readonly.count,
    internal: o.scopes.internal.count,
    people: o.users.length,
    total: o.totalCount,
    bytes: o.totalBytes,
  });
}

async function filesLs(org, app, prefix, scope, user) {
  const params = new URLSearchParams({ scope });
  if (user) params.set("user", user);
  if (prefix) params.set("prefix", prefix);
  const res = await apiFetch(`/api/apps/${org}/${app}/files/ls?${params}`);
  const body = /** @type {Wire<FilesPage>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `files ls failed (${res.status})`);
  for (const f of body.files) {
    console.log(
      `${f.key}  ${formatBytes(f.size)}  ${f.contentType}  ${f.by ? f.by.name : "app server"}  ${f.at ? ago(f.at) : "—"}`,
    );
  }
  if (body.files.length === 0) {
    console.log(`No files in ${scope}${prefix ? ` under "${prefix}"` : ""}.`);
  }
  // One page, like `data ls` — a cursor means more exist; narrow with a prefix.
  if (body.cursor) {
    console.log(`… more files exist — narrow with a prefix: appato files ls <prefix>`);
  }
  emit("APPATO_FILE_LIST", {
    app: `${org}/${app}`,
    scope,
    user,
    prefix,
    count: body.files.length,
    truncated: Boolean(body.cursor),
  });
  for (const f of body.files) {
    emit("APPATO_FILE", {
      key: f.key,
      size: f.size,
      type: f.contentType,
      by: f.by ? f.by.name : null,
      at: f.at,
    });
  }
}

async function filesGet(org, app, key, scope, user, outPath) {
  // Dumping binary to a terminal is hostile: require -o or a pipe on a TTY.
  if (!outPath && process.stdout.isTTY) {
    throw new Error("won't write binary to a terminal — use -o <path> or pipe the output");
  }
  const params = new URLSearchParams({ scope, key });
  if (user) params.set("user", user);
  const res = await apiFetch(`/api/apps/${org}/${app}/files/file?${params}`);
  if (res.status === 404) {
    console.error(`no file ${JSON.stringify(key)} in ${scope}`);
    emit("APPATO_FILE", { app: `${org}/${app}`, scope, key, found: false });
    process.exit(1);
  }
  if (!res.ok) {
    // File bytes (GET /file) are out of the typed scope; only the error is read.
    const body = /** @type {any} */ (await res.json().catch(() => ({})));
    throw apiResponseError(body, `files get failed (${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") || "application/octet-stream";
  if (outPath) writeFileSync(outPath, buf);
  else process.stdout.write(buf);
  // With -o the bytes are in the file, so the machine line rides stdout as
  // usual; when the bytes are streamed to stdout it goes to STDERR instead, so
  // a pipe (`appato files get k | …`) or redirect stays the pure file bytes.
  emit(
    "APPATO_FILE_SAVED",
    { app: `${org}/${app}`, scope, key, size: buf.length, type, to: outPath },
    !outPath,
  );
}

async function filesPut(org, app, path, key, scope, user, type) {
  if (!existsSync(path)) throw new Error(`no such file: ${path}`);
  const body = readFileSync(path);
  const CAP = 25 * 1024 * 1024;
  if (body.length > CAP) {
    throw new Error(`file is ${formatBytes(body.length)} — the per-file cap is 25MB`);
  }
  const src = basename(path);
  const name = key || src;
  // A tiny, local extension→MIME map — the common uploads, nothing more. The
  // server never trusts it (it stores whatever content-type it's handed); it's
  // only so `put logo.png` does the obvious thing without a --type flag.
  const types = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    csv: "text/csv",
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
  };
  const ext = src.includes(".") ? src.slice(src.lastIndexOf(".") + 1).toLowerCase() : "";
  const contentType = type || types[ext] || "application/octet-stream";
  const params = new URLSearchParams({ scope, key: name });
  if (user) params.set("user", user);
  const res = await apiFetch(`/api/apps/${org}/${app}/files/file?${params}`, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  });
  // Blob upload (PUT /file) is out of the typed scope; only the error is read.
  const resBody = /** @type {any} */ (await res.json().catch(() => ({})));
  if (!res.ok) throw apiResponseError(resBody, `files put failed (${res.status})`);
  console.log(`✓ uploaded ${scope}:${name} (${formatBytes(body.length)})`);
  emit("APPATO_FILE_PUT", {
    app: `${org}/${app}`,
    scope,
    key: name,
    size: body.length,
    type: contentType,
  });
}

async function filesRm(org, app, key, scope, user) {
  const params = new URLSearchParams({ scope, key });
  if (user) params.set("user", user);
  const res = await apiFetch(`/api/apps/${org}/${app}/files/file?${params}`, { method: "DELETE" });
  const body = /** @type {Wire<FileDelete>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `files rm failed (${res.status})`);
  console.log(body.deleted ? `✓ deleted ${scope}:${key}` : `${scope}:${key} did not exist`);
  emit("APPATO_FILE_DELETED", {
    app: `${org}/${app}`,
    scope,
    key,
    existed: body.deleted,
  });
}

// ---------------------------------------------------------------------------
// cli/src/webhook.mjs

/**
 * Provisioned public capabilities. Labels are the stable code contract; URLs
 * are secret values minted and revoked by the platform.
 */
async function webhook(args = []) {
  const { org, app } = appConfig();
  const positional = args.filter((a) => !a.startsWith("-"));
  const [sub = "list", label] = positional;
  const base = `/api/apps/${org}/${app}/webhooks`;

  if (sub === "create" || sub === "request") {
    if (!label) throw new Error(`usage: appato webhook ${sub} <label>`);
    const res = await apiFetch(base, {
      method: "POST",
      body: JSON.stringify({ label }),
    });
    const body = /** @type {Wire<WebhookCreated>} */ (await res.json());
    if (!res.ok) throw apiResponseError(body, `webhook request failed (${res.status})`);
    if (args.includes("--json")) {
      console.log(JSON.stringify(body));
      return;
    }
    console.log(
      `${body.created ? "✓ provisioned" : "✓ already provisioned"} "${body.label}"\n${body.url}`,
    );
    emit("APPATO_WEBHOOK", {
      app: `${org}/${app}`,
      label: body.label,
      url: body.url,
      created_at: body.createdAt,
      created: body.created,
    });
    return;
  }

  if (sub === "delete" || sub === "rm" || sub === "revoke") {
    if (!label) throw new Error(`usage: appato webhook ${sub} <label>`);
    const res = await apiFetch(`${base}/${encodeURIComponent(label)}`, { method: "DELETE" });
    const body = /** @type {Wire<{ ok: true; deleted: true }>} */ (await res.json());
    if (!res.ok) throw apiResponseError(body, `webhook revoke failed (${res.status})`);
    console.log(`✓ revoked "${label}"`);
    emit("APPATO_WEBHOOK_DELETED", { app: `${org}/${app}`, label });
    return;
  }

  if (sub !== "list") {
    throw new Error(
      `unknown webhook command "${sub}" — use: list | create <label> | delete <label>`,
    );
  }
  const res = await apiFetch(base);
  const body = /** @type {Wire<WebhookList>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `webhook list failed (${res.status})`);
  if (args.includes("--json")) {
    console.log(JSON.stringify(body));
    return;
  }
  if (body.webhooks.length === 0) {
    console.log(`No webhooks. Request one with: appato webhook create <label>`);
  } else {
    for (const hook of body.webhooks) {
      console.log(`${hook.label}  ${hook.url}`);
      emit("APPATO_WEBHOOK", {
        app: `${org}/${app}`,
        label: hook.label,
        url: hook.url,
        created_at: hook.createdAt,
      });
    }
  }
  emit("APPATO_WEBHOOKS", { app: `${org}/${app}`, count: body.webhooks.length });
}

// ---------------------------------------------------------------------------
// cli/src/email.mjs

function printCapability(org, app, capability) {
  console.log(`Address: ${capability.namespace}`);
  console.log(
    `Inbound: ${capability.state.inbound}${capability.pauseReason.inbound ? ` — ${capability.pauseReason.inbound}` : ""}`,
  );
  console.log(
    `Outbound: ${capability.state.outbound}${capability.pauseReason.outbound ? ` — ${capability.pauseReason.outbound}` : ""}`,
  );
  if (!capability.providerAvailable && capability.providerError) {
    console.log(`Provider: unavailable — ${capability.providerError}`);
  }
  emit("APPATO_EMAIL", {
    app: `${org}/${app}`,
    namespace: capability.namespace,
    inbound: capability.state.inbound,
    outbound: capability.state.outbound,
    desired_inbound: capability.desired.inbound,
    desired_outbound: capability.desired.outbound,
  });
}

async function emailCommand(args = []) {
  const { org, app, root } = appConfig();
  const positional = args.filter(
    (value, index) => !value.startsWith("-") && !args[index - 1]?.startsWith("-"),
  );
  const [sub = "status", direction] = positional;
  const base = `/api/apps/${org}/${app}/email`;

  if (sub === "enable" || sub === "disable") {
    if (!["inbound", "outbound", "both"].includes(direction)) {
      throw new Error(`usage: appato email ${sub} inbound|outbound|both`);
    }
    const res = await apiFetch(`${base}/capability`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction, enabled: sub === "enable" }),
    });
    const body = /** @type {Wire<EmailCapability>} */ (await res.json());
    if (!res.ok) throw apiResponseError(body, `email ${sub} failed (${res.status})`);
    writeManifestEmail(root, body);
    console.log(
      `✓ ${sub === "enable" ? "enabled" : "disabled"} ${direction} email for ${body.namespace}`,
    );
    emit("APPATO_EMAIL_READY", {
      app: `${org}/${app}`,
      direction,
      enabled: sub === "enable",
      inbound: body.state.inbound,
      outbound: body.state.outbound,
    });
    return;
  }

  if (sub === "status") {
    const res = await apiFetch(base);
    const body = /** @type {Wire<EmailCapability>} */ (await res.json());
    if (!res.ok) throw apiResponseError(body, `email status failed (${res.status})`);
    writeManifestEmail(root, body);
    if (args.includes("--json")) console.log(JSON.stringify(body));
    else printCapability(org, app, body);
    return;
  }

  if (sub === "logs" || sub === "list") {
    const query = new URLSearchParams();
    for (const [flag, key] of [
      ["--direction", "direction"],
      ["--status", "status"],
      ["--from", "from"],
      ["--to", "to"],
      ["--alias", "alias"],
      ["--category", "category"],
      ["--limit", "limit"],
      ["--cursor", "cursor"],
    ]) {
      const value = flagValue(args, flag);
      if (value !== undefined) query.set(key, value);
    }
    const shortLimit = flagValue(args, "-n");
    if (shortLimit !== undefined && !query.has("limit")) query.set("limit", shortLimit);
    const since = flagValue(args, "--since");
    if (since) query.set("after", String(parseSince(since)));
    const res = await apiFetch(`${base}/messages?${query}`);
    const body = /** @type {Wire<EmailMessages>} */ (await res.json());
    if (!res.ok) throw apiResponseError(body, `email logs failed (${res.status})`);
    if (args.includes("--json")) {
      console.log(JSON.stringify(body));
    } else if (!body.messages.length) {
      console.log("No email messages in this window.");
    } else {
      for (const message of body.messages) {
        console.log(
          `${new Date(message.occurredAt).toISOString()}  ${message.direction.padEnd(8)}  ${message.state.padEnd(18)}  ${message.from ?? "—"} → ${message.to ?? "—"}  ${message.subject}`,
        );
        emit("APPATO_EMAIL_MESSAGE", {
          app: `${org}/${app}`,
          id: message.id,
          direction: message.direction,
          status: message.state,
          from: message.from,
          to: message.to,
          subject: message.subject,
          occurred_at: message.occurredAt,
        });
      }
    }
    emit("APPATO_EMAILS", {
      app: `${org}/${app}`,
      count: body.messages.length,
      next_cursor: body.nextCursor,
    });
    return;
  }

  if (sub === "get") {
    if (!direction) throw new Error("usage: appato email get <message-id> [--body] [--json]");
    const res = await apiFetch(`${base}/messages/${encodeURIComponent(direction)}`);
    const body = /** @type {Wire<EmailMessage>} */ (await res.json());
    if (!res.ok) throw apiResponseError(body, `email get failed (${res.status})`);
    if (args.includes("--json")) {
      console.log(JSON.stringify(body));
      return;
    }
    console.log(`${body.direction} ${body.state} — ${body.id}`);
    console.log(`${body.from ?? "—"} → ${body.to ?? "—"}`);
    console.log(`Subject: ${body.subject}`);
    console.log(`When: ${new Date(body.occurredAt).toISOString()}`);
    if (args.includes("--body")) {
      console.log("");
      console.log(body.body.text ?? body.body.html ?? "(no body)");
    }
    emit("APPATO_EMAIL_MESSAGE", {
      app: `${org}/${app}`,
      id: body.id,
      direction: body.direction,
      status: body.state,
      from: body.from,
      to: body.to,
      subject: body.subject,
      occurred_at: body.occurredAt,
    });
    return;
  }

  throw new Error(`unknown email command "${sub}" — use: status | enable | disable | logs | get`);
}

// ---------------------------------------------------------------------------
// cli/src/logs.mjs

/** Client↔server join: one story when a browser fetch and server error share a rid.
 * @twin logs-server-errors */
function serverErrorsByRid(events) {
  const m = new Map();
  for (const e of events) {
    if (
      e.rid &&
      e.level === "error" &&
      (e.source === "http" || e.source === "webhook" || e.source === "app")
    ) {
      m.set(e.rid, e);
    }
  }
  return m;
}

/** Never render an empty event row, including browser SDK drop reports.
 * @twin logs-event-text */
function eventText(e) {
  if (
    e.message === "client_report" &&
    e.context &&
    typeof e.context === "object" &&
    !Array.isArray(e.context)
  ) {
    const counts = Object.entries(e.context).filter((kv) => typeof kv[1] === "number" && kv[1] > 0);
    if (counts.length > 0) {
      return `browser SDK dropped events: ${counts.map(([reason, n]) => `${reason} ×${n}`).join(", ")}`;
    }
  }
  if (e.message) return e.message;
  if (e.request) return `${e.request.method} ${e.request.path} → ${e.request.status}`;
  return e.exception ? `${e.exception.type}: ${e.exception.value}` : `(${e.kind})`;
}

function clientDropCount(e) {
  if (
    e.message !== "client_report" ||
    typeof e.context !== "object" ||
    !e.context ||
    Array.isArray(e.context)
  ) {
    return 0;
  }
  return Object.values(e.context)
    .filter((n) => typeof n === "number" && n > 0)
    .reduce((total, n) => total + n, 0);
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
  const body = /** @type {Wire<AppLogs>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `logs failed (${res.status})`);
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
  const serverErrByRid = serverErrorsByRid(events);
  // Client-side drop reports (L5): the browser SDK ships its own drop
  // counts as a client_report event with {reason: count} in context —
  // render the counts and total them for the machine line's
  // client_dropped.
  let clientDropped = 0;
  for (const e of events) {
    clientDropped += clientDropCount(e);
    const v = e.v != null && e.v !== body.deployedVersion ? ` [v${e.v}]` : "";
    const who = e.userEmail ? ` (${e.userEmail})` : "";
    // Per-row truncation (L5): the row itself says capture cut it, not just
    // the summary's single boolean. Counterpart: the truncated chip in
    // web/src/features/apps/Logs.tsx EventRow.
    const cut = e.truncated ? " [truncated]" : "";
    // NO duration printed until `request.ms` means response time — it is
    // currently time-to-headers, which excludes the slowest part of a
    // streamed response. The console shows it labeled "server time"; here
    // the flat line stays duration-free (agents read ms as latency).
    console.log(`${hms(e.ts)} ${e.source} ${e.level} ${eventText(e)}${v}${who}${cut}`);
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
    if (clientDropped > 0)
      parts.push(`${clientDropped} event(s) were dropped in the browser before sending`);
    if (s.truncated) parts.push(`some entries are truncated`);
    console.log(`⚠ ${parts.join("; ")} — the picture above is incomplete.`);
  }
  emit("APPATO_LOGS", {
    app: `${org}/${app}`,
    deployed_version: body.deployedVersion,
    window_since: body.since,
    entries: s.entries,
    errors: s.errors,
    error_groups: s.errorGroups,
    stale_errors: s.stale,
    dropped: s.dropped,
    client_dropped: clientDropped,
    truncated: !!s.truncated,
  });
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
  const body = /** @type {Wire<ConsoleLogs>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `console logs failed (${res.status})`);
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
    console.log(
      `No server console output in this window (default 1h; --since 24h reaches back; ~7-day retention).`,
    );
  }
  emit("APPATO_LOGS_CONSOLE", {
    app: `${org}/${app}`,
    window_since: body.since,
    entries: events.length,
  });
}

// ---------------------------------------------------------------------------
// cli/src/status.mjs

async function status(args = []) {
  const json = args.includes("--json");
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
  const body = /** @type {Wire<AppDetail>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `status failed (${res.status})`);
  const local = collectFiles(root);
  const localBinHashes = binaryHashes(local.binary);
  const localSha = localSetSha(local.files, localBinHashes);
  const changedFiles = manifestDiff({ ...hashFiles(local.files), ...localBinHashes }, man.files);
  const dirty = changedFiles.length > 0;

  // Distinguish "behind" (local equals an older pushed version — sync) from
  // "modified" (unpushed local edits — push) via version content hashes.
  let syncState = "in_sync";
  let matchesVersion = body.latestVersion;
  if (dirty) {
    // Unknown (a versions read failed) stays "modified" — the safe direction:
    // status must not invite a sync it can't prove is lossless.
    const match = await findVersionBySha(org, app, localSha).catch(() => null);
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
  if (body.status === "paused") {
    console.log(`status:   paused — not serving, data frozen; resume it with: appato resume`);
  } else if (body.status === "trashed") {
    // A trashed checkout is offline like a paused one, but on a countdown to
    // permanent deletion — say so, and never let the stale deploy status read
    // as if it were serving (docs/LIFECYCLE.md).
    const days = body.deletesAt
      ? Math.max(0, Math.ceil((body.deletesAt - Date.now()) / 86_400_000))
      : null;
    const countdown =
      days === null ? "" : ` — deletes forever in ${days} day${days === 1 ? "" : "s"}`;
    console.log(`status:   in trash — not serving${countdown}; restore it with: appato restore`);
  } else {
    console.log(`status:   ${out.deployStatus}${out.deployError ? ` (${out.deployError})` : ""}`);
  }
  console.log(
    `version:  latest v${out.latestVersion}, deployed ${out.deployedVersion ? `v${out.deployedVersion}${out.deployedAt ? ` (${ago(out.deployedAt)})` : ""}` : "never"}`,
  );
  if (!dirty) {
    console.log(`local:    in sync with pushed version`);
  } else if (syncState === "behind") {
    console.log(
      `local:    ⚠ behind — local matches v${matchesVersion}, latest is v${out.latestVersion}; run: appato sync`,
    );
  } else {
    console.log(
      `local:    ⚠ ${changedFiles.length} file(s) with unpushed changes — run: appato push`,
    );
  }
  emit("APPATO_STATUS", {
    app: out.app,
    deployed_version: out.deployedVersion,
    deployed_at: out.deployedAt,
    dirty: out.dirty,
    state: syncState,
    status: body.status,
    deletes_at: body.deletesAt,
    sha: out.localSha,
    url: out.url,
  });
}

/**
 * `status` outside any app: the caller's own apps (orgs can be huge, so the
 * full list is opt-in via --all) + every checkout one level down.
 */
async function workspaceStatus(json = false, all = false) {
  const res = await apiFetch(`/api/apps${all ? "" : "?mine=1"}`);
  const body = /** @type {Wire<AppList>} */ (await res.json());
  if (!res.ok) throw apiResponseError(body, `status failed (${res.status})`);
  const local = scanChildApps(process.cwd());
  const localByApp = new Map(local.map((c) => [`${c.org}/${c.app}`, c.dir]));
  const apps = body.apps.map((a) => ({
    slug: a.slug,
    title: a.name + (a.status === "paused" ? "  [paused]" : ""),
    dir: localByApp.get(`${body.org}/${a.slug}`) ?? null,
  }));
  // Checkouts of apps outside the fetched list (e.g. a coworker's app you
  // cloned) still belong in the picture.
  const listed = new Set(apps.map((a) => a.slug));
  for (const c of local) {
    if (c.org === body.org && !listed.has(c.app)) {
      apps.push({ slug: c.app, title: "(not in your current app-builder grants)", dir: c.dir });
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
        : `You aren't an active builder on any apps in ${body.org} — request an app grant, create one, or use \`appato status --all\` for the member directory.`,
    );
  } else {
    console.log(
      `${all ? "All apps" : "Your apps"} in ${body.org} (● = checked out below this directory):`,
    );
    for (const a of apps) {
      console.log(
        a.dir
          ? `  ● ${a.slug}  ${a.title}  → ./${a.dir}/`
          : all
            ? `  ○ ${a.slug}  ${a.title}  (directory only — request app-builder access in the console to clone)`
            : `  ○ ${a.slug}  ${a.title}  (appato clone ${a.slug})`,
      );
    }
    if (!all)
      console.log(`(apps you may build — \`appato status --all\` lists the member directory)`);
  }
  emit("APPATO_WORKSPACE", {
    org: body.org,
    scope,
    apps: apps.length,
    checked_out: apps.filter((a) => a.dir).length,
  });
  for (const a of apps) {
    emit("APPATO_APP", {
      app: `${body.org}/${a.slug}`,
      dir: a.dir ? `./${a.dir}` : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// cli/src/install.mjs

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
    console.log(
      `Not on PATH — use ${wrapper} directly, or add: export PATH="$HOME/.appato/bin:$PATH"`,
    );
  }
  emit("APPATO_INSTALLED", { version, path: wrapper });
}

// ---------------------------------------------------------------------------
// cli/src/telemetry.mjs

/**
 * Best-effort CLI client telemetry: every request self-describes the coding
 * agent/harness driving it (Claude Code, Codex, Cursor, …), OS/arch/node, and —
 * where the environment reveals it — the agent version, reasoning effort, and
 * plan tier. Purely observational: any absent/unreadable/malformed source
 * yields an omitted field, never an error, and NOTHING here may affect a
 * command's success. Every file read is wrapped so one bad source never voids
 * the others, and credential files (auth.json, rollout transcripts) are read
 * only for the single hint documented at the read site — never logged or
 * otherwise transmitted.
 */

/**
 * Printable-ASCII (0x20–0x7E), capped at 64 chars; empty → undefined (dropped
 * from the header). Belt against a config/env value carrying newlines, control
 * bytes, or unicode into a header we serialize verbatim.
 * @param {unknown} v
 * @returns {string | undefined}
 */
function clean(v) {
  if (typeof v !== "string") return undefined;
  let out = "";
  for (let i = 0; i < v.length && out.length < 64; i++) {
    const c = v.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) out += v[i];
  }
  return out.length ? out : undefined;
}

/** Read at most `max` bytes of a file into a fixed buffer (never the whole
 * thing — these files can hold a full session transcript or private state).
 * @param {string} path
 * @param {number} max
 * @returns {string} */
function readCapped(path, max) {
  const buf = Buffer.alloc(max);
  const fd = openSync(path, "r");
  let bytes = 0;
  try {
    bytes = readSync(fd, buf, 0, max, 0);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8", 0, bytes);
}

/** Directory entries that are all-digits (year/month/day session dirs), sorted
 * numerically descending; unreadable dir → []. */
function listDescNumeric(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((e) => /^\d+$/.test(e)).sort((a, b) => Number(b) - Number(a));
}

/**
 * Full client description for one invocation, or null under DO_NOT_TRACK.
 * Pure-ish and injectable for tests (env object + home dir; every file path
 * derives from these).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {Record<string, string | boolean> | null}
 */
function detectClient(env = process.env, home = homedir()) {
  // DO_NOT_TRACK (consoledonottrack.com): the industry opt-out. Honor it by
  // sending NO telemetry at all — no agent detection, no config-file reads,
  // and no X-Appato-Client header (even a coarse {v,os,arch,node} send would
  // mint a per-user cli_client row server-side, defeating the opt-out).
  if (env.DO_NOT_TRACK && env.DO_NOT_TRACK !== "0") return null;

  /** @type {Record<string, string | boolean>} */
  const base = {
    v: VERSION,
    os: process.platform,
    arch: process.arch,
    node: process.versions.node,
  };

  /** @type {Record<string, string | undefined>} */
  const info = {};
  detectAgent(info, env, home);
  // Always-on context, regardless of agent.
  if (env.CONDUCTOR_WORKSPACE_PATH || env.__CFBundleIdentifier === "com.conductor.app") {
    info.harness = "conductor";
  }
  info.term = env.TERM_PROGRAM;

  /** @type {Record<string, string | boolean>} */
  const out = { ...base };
  for (const key of Object.keys(info)) {
    const c = clean(info[key]);
    if (c !== undefined) out[key] = c;
  }
  if (env.CI) out.ci = true;
  return out;
}

/**
 * First-match-wins agent detection.
 * @param {Record<string, string | undefined>} info
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
function detectAgent(info, env, home) {
  // Codex BEFORE Claude Code: Codex's spawn path injects CODEX_THREAD_ID per
  // command, so when both harness markers are present the common nesting is
  // Claude Code spawning `codex`, which then ran appato — Codex is the innermost
  // driver actually issuing this call. The reverse nesting (Codex spawning
  // Claude Code) is rare, so preferring Codex on a tie is right.
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED) {
    info.agent = "codex";
    enrichCodex(info, env, home);
    return;
  }
  if (env.CLAUDECODE === "1") {
    info.agent = "claude-code";
    enrichClaude(info, env, home);
    return;
  }
  const other = detectOther(env);
  if (other) {
    info.agent = other.agent;
    if (other.agentVersion) info.agentVersion = other.agentVersion;
  }
}

/**
 * Codex enrichment: exact running cli version + resolved model/effort from the
 * session rollout, configured defaults as a fallback, plan from auth.json.
 * @param {Record<string, string | undefined>} info
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
function enrichCodex(info, env, home) {
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  // The rollout gives the EXACT running cli version + resolved session model —
  // ~/.codex/version.json is only an update-check cache (its latest_version is
  // NOT what's running), so never use it.
  if (env.CODEX_THREAD_ID) {
    try {
      readCodexRollout(info, codexHome, env.CODEX_THREAD_ID);
    } catch {
      // unreadable rollout — fall through to the configured defaults
    }
  }
  if (!info.model || !info.effort) {
    try {
      readCodexConfig(info, codexHome);
    } catch {
      // no/unreadable config.toml
    }
  }
  try {
    info.plan = codexPlan(codexHome);
  } catch {
    // no/unreadable/garbled auth.json — omit plan
  }
}

/**
 * Walk `sessions/<YYYY>/<MM>/<DD>/` newest-first (≤10 day-dirs total) for the
 * rollout file whose name carries the thread id, then parse it.
 * @param {Record<string, string | undefined>} info
 * @param {string} codexHome
 * @param {string} threadId
 */
function readCodexRollout(info, codexHome, threadId) {
  const sessions = join(codexHome, "sessions");
  let dayDirs = 0;
  for (const y of listDescNumeric(sessions)) {
    for (const m of listDescNumeric(join(sessions, y))) {
      for (const d of listDescNumeric(join(sessions, y, m))) {
        if (dayDirs >= 10) return;
        dayDirs++;
        const dir = join(sessions, y, m, d);
        let files;
        try {
          files = readdirSync(dir);
        } catch {
          continue;
        }
        // Shape: rollout-<ts>-<threadid>.jsonl
        const match = files.find((f) => f.endsWith(".jsonl") && f.includes(threadId));
        if (match) {
          parseRollout(info, join(dir, match));
          return;
        }
      }
    }
  }
}

/**
 * Read only the FIRST 64KB of a rollout (the file can hold the whole session
 * transcript, incl. private prompts — never read more, never log it), pull the
 * session_meta cli_version and the first turn_context model/effort.
 * @param {Record<string, string | undefined>} info
 * @param {string} path
 */
function parseRollout(info, path) {
  const text = readCapped(path, 65536);
  let gotMeta = false;
  let gotTurn = false;
  for (const line of text.split("\n")) {
    if (gotMeta && gotTurn) break;
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // A truncated final line (64KB cutoff) or a malformed record — skip it.
      continue;
    }
    const payload = rec?.payload;
    if (!payload) continue;
    if (!gotMeta && rec.type === "session_meta") {
      if (typeof payload.cli_version === "string") info.agentVersion = payload.cli_version;
      gotMeta = true;
    } else if (!gotTurn && rec.type === "turn_context") {
      if (typeof payload.model === "string") info.model = payload.model;
      if (typeof payload.effort === "string") info.effort = payload.effort;
      gotTurn = true;
    }
  }
}

/**
 * Configured model/effort defaults — line-anchored TOML matches, good enough
 * when the rollout is unreadable.
 * @param {Record<string, string | undefined>} info
 * @param {string} codexHome
 */
function readCodexConfig(info, codexHome) {
  const raw = readCapped(join(codexHome, "config.toml"), 262144);
  if (!info.model) {
    const m = /^\s*model\s*=\s*"([^"]*)"/m.exec(raw);
    if (m) info.model = m[1];
  }
  if (!info.effort) {
    const e = /^\s*model_reasoning_effort\s*=\s*"([^"]*)"/m.exec(raw);
    if (e) info.effort = e[1];
  }
}

/**
 * Codex plan tier from auth.json. For a ChatGPT login, decode ONLY the
 * chatgpt_plan_type claim from the id_token — the file holds bearer
 * credentials, so nothing else is read, stored, or transmitted, and there is no
 * signature verification (a local best-effort hint, not an authorization).
 * @param {string} codexHome
 * @returns {string | undefined}
 */
function codexPlan(codexHome) {
  const auth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
  if (auth.auth_mode === "apikey") return "apikey";
  if (auth.auth_mode === "chatgpt") {
    const idToken = auth.tokens?.id_token;
    if (typeof idToken !== "string") return undefined;
    const claims = decodeJwtClaims(idToken);
    const auth0 = claims?.["https://api.openai.com/auth"];
    const plan = auth0?.chatgpt_plan_type;
    // Known values include free/go/plus/pro/team/business/enterprise/edu, but
    // pass ANY short string through raw.
    return typeof plan === "string" ? plan : undefined;
  }
  return undefined;
}

/** Base64url-decode + JSON.parse a JWT's MIDDLE (claims) segment. Throws on
 * garbage; the caller catches. */
function decodeJwtClaims(jwt) {
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

/**
 * Claude Code enrichment: entrypoint, version (env-only), effort, plan tier.
 * The current session MODEL is NOT detectable for Claude Code (no env var
 * exists; the feature request was closed as not-planned) — it comes only from
 * push's --model flag. Deliberately does NOT read ANTHROPIC_MODEL: that's a
 * user-pinned override, not the running model.
 * @param {Record<string, string | undefined>} info
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
function enrichClaude(info, env, home) {
  info.entry = env.CLAUDE_CODE_ENTRYPOINT;
  info.agentVersion = claudeVersion(env);
  info.effort = env.CLAUDE_EFFORT;
  try {
    info.plan = claudePlan(env, home);
  } catch {
    // missing/oversized/malformed .claude.json — omit plan
  }
}

/**
 * Claude Code's running version, when the environment reveals it. Only
 * version-per-directory installs (e.g. Conductor's binary manager, which puts
 * the version in the exec path or AI_AGENT) expose it — a plain npm/homebrew
 * install has NO version anywhere in env, so undefined (unknown) is the honest
 * common case, not a bug.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
function claudeVersion(env) {
  if (typeof env.CLAUDE_CODE_EXECPATH === "string") {
    const m = /\d+\.\d+\.\d+/.exec(env.CLAUDE_CODE_EXECPATH);
    if (m) return m[0];
  }
  if (typeof env.AI_AGENT === "string") {
    const m = /^claude-code_([\d-]+)_agent$/.exec(env.AI_AGENT);
    if (m) return m[1].replace(/-/g, ".");
  }
  return undefined;
}

/**
 * Claude Code plan tier from ~/.claude.json's oauthAccount block.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 * @returns {string | undefined}
 */
function claudePlan(env, home) {
  const path = join(env.CLAUDE_CONFIG_DIR || home, ".claude.json");
  // The file holds per-project state and can grow to several MB — statSync and
  // skip anything large rather than JSON.parse a huge blob on every request.
  if (statSync(path).size > 20 * 1024 * 1024) return undefined;
  const conf = JSON.parse(readFileSync(path, "utf8"));
  const acct = conf?.oauthAccount;
  if (!acct) return undefined;
  // Raw strings, never mapped/normalized: the full value enum is unverified
  // (e.g. "default_claude_max_20x", "claude_max") and the block can be absent
  // even for a valid session → omit.
  const plan = acct.organizationRateLimitTier || acct.organizationType || acct.billingType;
  return typeof plan === "string" ? plan : undefined;
}

/**
 * Name-only detection for the other agents (no enrichment). GitHub Copilot has
 * no env marker — undetectable, falls through.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ agent: string, agentVersion?: string } | null}
 */
function detectOther(env) {
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return { agent: "cursor" };
  if (env.GEMINI_CLI) return { agent: "gemini-cli" };
  if (env.AGENT === "amp") return { agent: "amp" };
  if (env.GOOSE_TERMINAL || env.AGENT === "goose") return { agent: "goose" };
  if (env.CLINE_ACTIVE) return { agent: "cline" };
  if (env.OPENCODE_CLIENT || env.OPENCODE) return { agent: "opencode" };
  if (env.TRAE_AI_SHELL_ID) return { agent: "trae" };
  if (typeof env.AI_AGENT === "string") {
    const m = /^([a-z0-9-]+)_([\d-]+)_agent$/i.exec(env.AI_AGENT);
    if (m) return { agent: m[1], agentVersion: m[2].replace(/-/g, ".") };
  }
  return null;
}

/** @type {Record<string, string | boolean> | null | undefined} */
let clientInfoMemo;

/** Memoized detectClient() — detection is env/disk state, stable per process.
 * Null = the user opted out (DO_NOT_TRACK).
 * @returns {Record<string, string | boolean> | null} */
function clientInfo() {
  if (clientInfoMemo === undefined) clientInfoMemo = detectClient();
  return clientInfoMemo;
}

/** @type {string | undefined} */
let selfReportedModel;

/** Push's --model flag: the model id the agent self-reports it's running as.
 * Fills/overrides the header `model` field on subsequent clientHeaders() calls.
 * @param {string | undefined} model */
function setSelfReportedModel(model) {
  selfReportedModel = model;
}

/** The request headers. The plain User-Agent is ordinary HTTP and always
 * present; X-Appato-Client (the telemetry) is ABSENT entirely under
 * DO_NOT_TRACK — any send at all would mint a server-side cli_client row for
 * an opted-out user. Never collides with caller headers.
 * @returns {{ "User-Agent": string, "X-Appato-Client"?: string }} */
function clientHeaders() {
  const ua =
    "appato-cli/" +
    VERSION +
    " (" +
    process.platform +
    "; " +
    process.arch +
    ") node/" +
    process.versions.node;
  const detected = clientInfo();
  if (detected === null) return { "User-Agent": ua };
  /** @type {Record<string, string | boolean>} */
  const info = { ...detected };
  if (selfReportedModel) {
    const c = clean(selfReportedModel);
    if (c !== undefined) info.model = c;
  }
  const client = JSON.stringify(info);
  // Field caps keep this well under 1KB; belt-and-braces, if it somehow blows
  // past 2KB drop the header outright (same reasoning as the opt-out: a
  // coarse-only row is worse than no row).
  if (client.length > 2048) return { "User-Agent": ua };
  return { "User-Agent": ua, "X-Appato-Client": client };
}

// ---------------------------------------------------------------------------
// cli/src/tree.mjs

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
          // No client-side per-source-file cap: that limit is a plan knob
          // (PlanLimits.maxFileBytes) the server enforces at push (src/build.ts),
          // and a client literal would wrongly block a plan with a higher one.
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

// ---------------------------------------------------------------------------
// cli/src/hash.mjs

/**
 * Content address for one file.
 * MUST stay byte-identical to sha256Hex() in src/hash.ts on the server —
 * these are the addresses the manifest is expressed in, so a divergence
 * would make every file look changed.
 * @twin hash-sha256
 */
function sha256Hex(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Content address for one BINARY file — sha256 over raw bytes (a text
 * file's two forms hash identically, since its bytes ARE its UTF-8).
 * MUST stay byte-identical to sha256HexBytes() in src/hash.ts — these
 * addresses decide which blobs need uploading before a push.
 * @twin hash-sha256-bytes
 */
function sha256HexBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Deterministic short hash of a file set (path + content, sorted).
 * MUST stay byte-identical to filesSha() in src/hash.ts on the server — sync
 * compares this against version shas from the API.
 * @twin hash-files-sha
 */
function filesSha(files) {
  const h = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    h.update(path)
      .update("\0")
      .update(files[path] ?? "")
      .update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

/**
 * Whole-set validator over a {path: sha256} map.
 * MUST stay byte-identical to manifestSha() in src/hash.ts — a delta push is
 * only safe because both ends compute this the same way: this states what
 * the full set hashes to, the server reconstructs and checks.
 * @twin hash-manifest-sha
 */
function manifestSha(files) {
  return sha256Hex(JSON.stringify(Object.fromEntries(Object.entries(files).sort())));
}

// ---------------------------------------------------------------------------
// cli/src/wire.mjs

async function fetchManifest(org, app) {
  const res = await apiFetch(`/api/apps/${org}/${app}/manifest`);
  // Manifest reads carry ETag/version-skew semantics — out of the typed scope.
  const body = /** @type {any} */ (await res.json());
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
  if (!res.ok) throw apiResponseError(body, `could not read ${org}/${app} (${res.status})`);
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
 * paused) surface from the push itself, which is the request that
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
    ? {
        ...meta,
        base: delta.base,
        files: delta.files,
        deleted: delta.deleted,
        sha256: delta.sha256,
        binary: binHashes,
      }
    : { ...meta, files, binary: binHashes };
  const gz = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  return apiFetch(`/api/apps/${org}/${app}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Appato-Encoding": "gzip" },
    body: gz,
  });
}

/** One file's BYTES, addressed by hash so a push landing mid-sync can't
 *  swap the bytes we asked for. Returns a Buffer for every kind of file —
 *  downloads are bytes (docs/SYNC.md S33); text is its UTF-8. */
async function fetchFile(org, app, path, sha256) {
  const res = await apiFetch(
    `/api/apps/${org}/${app}/file?path=${encodeURIComponent(path)}&sha256=${sha256}`,
  );
  if (!res.ok) {
    const body = /** @type {any} */ (await res.json().catch(() => ({})));
    throw apiResponseError(body, `could not fetch ${path} (${res.status})`);
  }
  // Version-skew tolerance: a not-yet-propagated pre-0.7 server answers
  // JSON `{content}`; the current wire is raw octet-stream. Without this
  // branch, that window writes a JSON envelope into the working tree as
  // file content.
  if ((res.headers.get("content-type") || "").includes("application/json")) {
    const body = /** @type {any} */ (await res.json());
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
  const body = /** @type {any} */ (await res.json().catch(() => ({})));
  if (!res.ok) throw apiResponseError(body, `could not upload ${path} (${res.status})`);
  return body.sha256;
}

// ---------------------------------------------------------------------------
// cli/src/util.mjs

// Same contract as web/src/lib/time.ts ago(): the "ago" is included.
// (Deliberately duplicated — the CLI stays a single dependency-free file.)
// @twin time-ago
function ago(msEpoch) {
  const s = Math.max(0, Math.round((Date.now() - msEpoch) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Same contract as web/src/lib/time.ts until(): the "in" is included.
// (Deliberately duplicated — see the note on ago().)
// @twin time-until
function until(msEpoch) {
  const s = Math.max(0, Math.round((msEpoch - Date.now()) / 1000));
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

// Same contract as web/src/features/apps/data.ts formatBytes().
// @twin format-bytes
function formatBytes(n) {
  const f = (v, u) => `${v.toFixed(1).replace(/\.0$/, "")} ${u}`;
  if (n >= 1024 * 1024 * 1024) return f(n / 1024 / 1024 / 1024, "GB");
  if (n >= 1024 * 1024) return f(n / 1024 / 1024, "MB");
  if (n >= 1024) return f(n / 1024, "KB");
  return `${n} B`;
}

/** Short local clock time (HH:MM:SS) for log lines. */
// @twin time-hms
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

// ---------------------------------------------------------------------------
// cli/src/main.mjs

const [, , command, ...args] = process.argv;

try {
  switch (command) {
    case "login":
      await login(args);
      break;
    case "logout":
      logout();
      break;
    case "whoami":
      await whoami();
      break;
    case "create":
      await create(args);
      break;
    case "clone":
      await clone(args);
      break;
    case "show":
      await show(args);
      break;
    case "push":
      await push(args);
      break;
    case "sync":
      await sync(args);
      break;
    case "history":
      await history(args);
      break;
    case "cron":
    case "crons":
      await cron(args);
      break;
    case "data":
      await data(args);
      break;
    case "files":
      await files(args);
      break;
    case "webhook":
    case "webhooks":
      await webhook(args);
      break;
    case "email":
      await emailCommand(args);
      break;
    case "rollback":
      await rollback(args);
      break;
    case "pause":
      await pause();
      break;
    case "resume":
      await resume();
      break;
    case "trash":
      await trash();
      break;
    case "restore":
      await restore();
      break;
    case "delete":
      await deleteForever(args);
      break;
    case "status":
      await status(args);
      break;
    case "logs":
      await logs(args);
      break;
    case "sdk":
    case "howto":
    case "docs":
      sdkHelp();
      break;
    case "install":
      await install();
      break;
    case "upgrade":
      await install();
      break;
    case "--version":
    case "version":
      console.log(VERSION);
      break;
    default:
      usage();
      process.exit(command ? 1 : 0);
  }
} catch (err) {
  if (err?.apiCode) {
    emit(
      "APPATO_ERROR",
      {
        code: err.apiCode,
        message: err.message,
        ...(err.actionUrl ? { action_url: err.actionUrl } : {}),
      },
      true,
    );
  }
  console.error(`error: ${err.message}`);
  process.exit(1);
}
