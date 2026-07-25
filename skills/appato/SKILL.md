---
name: appato
description: Build and deploy small internal web apps ("utilities") on the appato platform. Use whenever the user asks to build, change, or deploy an appato app, or asks for a small internal tool/utility their team can use. Handles creating the app, writing the code, and keeping it deployed via the appato CLI.
allowed-tools: Bash(appato *)
---

# Building apps on appato

appato hosts small internal-only web apps for the user's company. You write
the code locally; the `appato` CLI deploys it. Apps are live at
`https://<org>-<app>.apps.appato.com` and are only reachable by signed-in
members of the user's company — never build login screens; the platform
handles auth.

## How apps live on disk

Each app is one self-contained directory named after its slug (e.g.
`pto-tracker/`), holding the app's files plus `appato.json` (identity +
metadata). Apps never nest. Users typically keep app directories as siblings
in one place (suggest `~/appato/` when starting fresh, but any directory
works — including a subdir of an existing project).

The platform is the source of truth: every push is an immutable version, so
local directories are disposable working copies. `appato clone` re-creates
any app anywhere; `appato sync` updates a copy to the latest version.

The CLI anchors itself: inside an app (any depth), commands act on that app;
outside, `appato status` lists the org's apps and which are checked out
below the current directory. You never need to be in a special directory.

## Workflow

1. **Bootstrap** — find a working `appato`, in this order:
   1. `command -v appato` — in Claude Code this plugin puts `appato` on
      the Bash tool's PATH, so it's normally just available; verify with
      `appato --version` and use bare `appato` for every command below.
   2. `~/.appato/bin/appato` (self-installed copy; PATH not refreshed)
   3. Install it with the copy bundled in this plugin — one command, no
      shell scripting:
      `node "${CLAUDE_PLUGIN_ROOT}/bin/appato.mjs" install`
      then use `~/.appato/bin/appato`. This is the normal path in Codex
      (which doesn't put plugin binaries on PATH). Note for Codex: this
      writes to ~/.appato (outside the workspace) and fetches from the
      network, so Codex will ask to run it outside the sandbox — that's
      expected, once per machine; tell the user so it doesn't read as an
      error.

   **When a command is blocked** (permission prompt denied, auto-mode
   classifier, sandbox): stop — never rephrase or restructure a command to
   get past a block. Tell the user in your response, every time: which
   command was blocked, what it does, and their options — approve it, run
   it themselves, or (for the smoothest experience) add a permission rule
   for `Bash(appato *)` via /permissions or settings so every appato
   command is covered once.

   **Logging in**: if any command says the user isn't logged in, run
   `appato login --no-wait` — it prints an approval URL and exits
   immediately (no long-running process to time out). Share the URL,
   ask the user to approve in their browser, and after they confirm run any
   appato command (start with `whoami`) — the CLI completes the pending
   login automatically; approval order never matters. If even that is
   blocked by the permission system, that's correct behavior, not an error
   to work around: give the user `appato login` (with its full path if not
   on their shell PATH) to run in their own terminal and continue once
   they confirm.
2. **Orient**: run `appato status` before anything else. Outside an app it
   lists the user's own apps and which are checked out below the current
   directory (`--all` lists the whole org — use it when looking for a
   coworker's app); inside an app it reports deploy state and whether the
   local copy is current. Use this to decide between the paths below — and
   to avoid creating a duplicate of an app the user already has.
3. **Existing app?** If it isn't checked out here, run
   `appato clone <slug>` (creates `./<slug>/`). If it is, **run
   `appato sync` inside it before editing** so you work on the latest
   version — others (or the user's other machines) may have pushed since.
   If sync reports `APPATO_SYNC_BLOCKED`, the local copy has unpushed
   changes: push them first, or `appato sync --force` to discard them
   (ask the user before discarding work you didn't make).
4. **New app**: derive a short kebab-case slug from the app's purpose (e.g.
   "PTO tracker" → `pto-tracker`); lowercase letters/digits/single hyphens
   only. Check the `status` list first so the name is
   distinct from existing apps. Then run:
   `appato create <slug> --title "PTO Tracker" --description "..."`.
   This creates the `./<slug>/` directory itself — cd in afterward. If the
   slug is taken, the error lists similar existing apps — pick a more
   specific slug informed by that list (e.g. `eng-pto-tracker`), never a
   numbered suffix. If it's unclear whether a similar app already covers
   the need, check `appato status --all` before creating a duplicate.
   The title is the human name shown in the workspace; the description is
   1–2 sentences on what the app does and who it's for — write both for the
   user's coworkers, who will discover the app with no other context.
   The manifest, `appato.json`:
   - `org` and `app` are the app's identity — never change or delete them.
   - `title` and `description` are yours to maintain: when the app's
     purpose or scope changes, update them in `appato.json` like any other
     file. Every push syncs them to the platform.
   - `crons` (optional) declares the app's schedules — see "Scheduled jobs"
     below. Every push syncs the whole array, so removing an entry removes
     the schedule.
5. **Write code** (conventions below), then push and share the printed URL
   with the user.
6. **Push frequently, always with a change summary.** Run
   `appato push -m "<one-liner>" --details "<paragraph>"` whenever you
   finish a change — after each feature, fix, or edit batch, not just at
   the end. Push is fast and idempotent; treat it like saving.
   - `-m`: imperative, ≤ 72 chars, in user-facing language ("Add CSV export
     to the report page"), never internal jargon ("refactor helpers").
   - `--details`: 2–4 sentences — what changed for the app's users, why,
     and any notable decisions or limitations. Skip it only for trivial
     fixes. These power the platform's version history, rollback labels,
     and changelog — write them as if the user's coworkers will read them,
     because they will.
   - **Keep metadata current**: if the app's purpose or scope materially
     changed this turn, update `title`/`description` in `appato.json` so
     the workspace listing stays truthful (the next push syncs them).
     Maintain a `README.md` in the app directory describing how to use the
     app — the platform displays it on the app's page.
7. **If push reports a deploy error**, read the error, fix the code, and
   push again. The previous working version keeps serving until a push
   succeeds. If the user wants a previous version back (`appato history`
   lists them), run `appato rollback <version>` — it restores that
   version's files as a new version (history is append-only; nothing is
   lost) — then `appato sync` to update the local copy.
8. **Before ending ANY response where you touched app files, push — and
   state the deploy status explicitly**, using the values from the CLI's
   machine line (below): e.g. "Deployed to <url> (v12, sha 3f9a01c2b4d6)."
   or "⚠ NOT deployed — the last push failed: <reason>." Never end a turn
   leaving the user unsure whether the live app matches what you built. If
   you changed files but cannot push (not logged in, CLI missing), say so
   and tell the user what's needed.
9. **If any appato output mentions an upgrade** (or says the CLI is too
   old), run `appato upgrade`, then retry.

## CLI output contract

The last line(s) of appato commands are machine-readable — space-separated
`key=value` pairs (values JSON-quoted if they contain spaces). Parse these
for your deploy-status statement; don't scrape the human-readable lines
above them.

- `APPATO_DEPLOYED app=<org>/<slug> version=<n> sha=<12-hex> url=<url>` —
  push succeeded; the app is live at `url`.
- `APPATO_DEPLOY_FAILED app=<org>/<slug> version=<n> [sha=<12-hex>]
  error=<json-string>` — the code was saved but is NOT live; the previous
  version keeps serving. Fix and push again. (`sha` is present on push
  failures, absent on rollback failures.)
- `APPATO_ROLLED_BACK app=<org>/<slug> version=<n> restored=<m> url=<url>`
  — v`m`'s files were restored as new version `n`, which is now live.
  `restored` names the version that authored the content: rolling back to
  a version that was itself a rollback resolves to its origin, so `m` may
  differ from the version you passed. Local files are behind the new
  version — run `appato sync` before any further edits.
- `APPATO_STATUS app=<org>/<slug> deployed_version=<n|none>
  deployed_at=<ms-epoch|never> dirty=<true|false>
  state=<in_sync|behind|modified> archived=<true|false> sha=<12-hex>
  url=<url>` — `behind` means run `appato sync`; `modified` means unpushed
  local changes — push. `archived=true` means the app is offline by its
  owner's choice: pushes are refused; don't try to work around it — tell
  the user its owner can make it live again from the app's page in the
  console.
- `APPATO_WORKSPACE org=<org> scope=<mine|all> apps=<n> checked_out=<n>`
  followed by one `APPATO_APP app=<org>/<slug> dir=<"./dir"|none>` per app
  — printed by `status` when outside any app directory. `scope=mine` means
  only the user's own apps are listed (plus local checkouts); rerun with
  `--all` for the org-wide list.
- `APPATO_CREATED app=<org>/<slug> dir=<json-string> url=<url>` — app
  created; its directory is `dir`.
- `APPATO_CLONED app=<org>/<slug> version=<n> dir=<json-string> url=<url>`
  — checkout created (or `existing=true` if it was already there).
- `APPATO_SYNCED app=<org>/<slug> version=<n> changed=<true|false>
  [files=<n>] sha=<12-hex>` — local copy now matches version `n`. If
  `changed=true`, re-read files before editing.
- `APPATO_SYNC_BLOCKED app=<org>/<slug> latest_version=<n>
  local_sha=<12-hex>` — sync refused: local has unpushed changes.
- `APPATO_LOGIN_PENDING url=<url> expires_at=<ms-epoch>` — printed by
  `login --no-wait`: share `url` with the user; after they approve, any
  appato command completes the login.
- `APPATO_INSTALLED version=<semver> path=<json-string>` — CLI installed
  at `path`; use it for subsequent commands.
- `APPATO_CRONS app=<org>/<slug> count=<n> suspended=<true|false>` followed
  by one `APPATO_CRON name=<name> schedule=<json-string> tz=<zone>
  paused=<true|false> paused_by=<user|auto|none> next_at=<ms-epoch|none>
  failures=<n> last_status=<ok|error|timeout|skipped|missed|running|never>`
  per schedule. `paused_by=auto` means the platform stopped it after
  repeated failures — fix the handler, push, then
  `appato cron resume <name>`. `missed` is NOT a failure and needs no fix:
  the app was archived, so those fires never happened and are never
  replayed.
- `APPATO_CRON_RUN app=<org>/<slug> name=<name>
  status=<ok|error|timeout|skipped> http=<code|none> duration_ms=<n>
  error=<json-string> output=<json-string>` — result of `appato cron run`.
  Non-`ok` exits 2 (`skipped` means a previous run was still in flight —
  retry shortly). `output` is what the handler RETURNED on success (its
  response body, capped) — check it to confirm the job did the right thing,
  not merely that it answered 2xx. Empty for failures, whose body is folded
  into `error` instead.

`appato status --json` prints one JSON object (same fields plus
`changedFiles`) when you need the full picture.

## App conventions

- The entrypoint must be `index.ts` (or `index.js`) exporting a fetch
  handler:

  ```ts
  import { getUser } from "./_appato.js";

  export default {
    async fetch(request: Request): Promise<Response> {
      const user = getUser(request); // { id, email, name, org } — always set
      return new Response(`Hello ${user.name}`);
    },
  };
  ```

- **No npm dependencies.** Apps are plain TypeScript/JavaScript ES modules —
  no package.json, no imports from npm, no bundler. Split code across
  relative-imported files freely. Serve HTML/CSS/JS inline from the fetch
  handler (template strings are fine and normal here).
- `./_appato.js` is injected by the platform at deploy time — import it, but
  never create that file.
- For state, use the built-in storage + realtime APIs (next section). Do not
  call external databases unless the user provides one.
- The `/_appato/*` URL path is reserved by the platform — your fetch handler
  never sees it; don't route on it.
- Keep apps small and single-purpose. Prefer one screen that does the job
  over navigation and settings pages.
## Shared data & realtime

Every app has a private, zero-setup data store and realtime hub — no
provisioning, no credentials, no npm. (`appato sdk` prints this whole
reference — API surface, tiers, recipes, limits — whenever you need it.) Data is scoped to the app and visible
to all org members (it's an internal tool; there are no per-user secrets).

Three tiers — picking the right one matters:

- **storage** (persisted): messages, votes, tracker rows, settings.
- **presence** (lives while a tab is open): who's here, typing, cursors' owners.
- **broadcast** (fire-and-forget, never stored): reactions, pings, cursor moves.

Never store presence-shaped data (cursor positions, "is typing") in storage,
and never expect a broadcast to be replayed — if it must survive a reload,
it belongs in storage.

**Server side** (in your fetch handler), from `./_appato.js`:

```ts
import { storage, publish } from "./_appato.js";

await storage.set("polls/lunch", { question: "Where?", options: ["a", "b"] });
const poll = await storage.get("polls/lunch");        // undefined if missing
const key = await storage.push("messages/", { text }); // appends with a
    // server-assigned time-sortable id → keys sort chronologically
const n = await storage.increment("votes/pizza");      // atomic counter
const msgs = await storage.list("messages/", { limit: 50, reverse: true });
await storage.delete("polls/old");
await publish("refresh", { reason: "new data" });      // ephemeral broadcast
```

Keys are plain strings; use `/`-separated prefixes as collections
(`messages/`, `votes/`). Values are JSON (≤128KB each; ~100MB per app).

**SQL** for structured data (reports, joins, aggregates) — the app's own
private SQLite:

```ts
await storage.sql("CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY, who TEXT, amount REAL)");
await storage.sql("INSERT INTO expenses (who, amount) VALUES (?, ?)", [user.name, 12.5]);
const { rows } = await storage.sql("SELECT who, SUM(amount) AS total FROM expenses GROUP BY who");
await storage.sqlBatch([{ query: "...", params: [] }, { query: "..." }]); // one transaction
```

Table names prefixed `_appato_` are reserved. Rule of thumb: KV + `watch`
for anything live on screen; SQL when you need queries/joins (SQL tables do
NOT emit realtime change events).

**Browser side** — in the HTML your app serves, import the client SDK (it
knows the signed-in user; never build login or ask who the user is):

```html
<script type="module">
  import { appato } from "/_appato/client.js";

  appato.user;                            // { id, email, name, org } — verified
  appato.storage;                         // same verbs as the server SDK

  // Live view: cb fires with all entries under the prefix, immediately and
  // on every change (snapshot semantics — reconnects re-sync automatically).
  appato.watch("messages/", (entries) => {
    // entries: [{ key, value }] sorted by key (push keys = chronological)
    render(entries.map((e) => e.value));
  });

  const room = appato.channel();          // default channel "main"
  room.publish("reaction", { emoji: "🔥" });   // not echoed to sender
  room.on("reaction", (data, from) => showBurst(data.emoji, from.name));
  room.presence.set({ status: "viewing" });    // patch-merge; auto-leave on close
  room.presence.on((members) => renderRoster(members)); // [{ user, data }]

  // Optional. After a push or rollback, open tabs reload themselves as soon
  // as the new version is confirmed live for that user (skipped, with a
  // "reload" pill, if they have typed something). Register a handler only to
  // own that moment yourself.
  appato.onDeploy((version) => saveDraft().then(() => location.reload()));
</script>
```

Recipes: **chat** = `storage.push` + `appato.watch` + presence · **poll /
tracker** = `increment`/`set` + `watch` · **dashboard** = `watch` (+ server
`publish` for ticks) · **cursors / typing** = `channel` broadcast only.

`watch` is for prefixes with ≤500 entries (it delivers a full snapshot);
paginate bigger data with `storage.list`/SQL. Writes from any tab, the
server, or a coworker's browser all fan out to every watcher — you never
need polling, WebSocket code, reconnect handling, or a version check.

## Scheduled jobs (reminders, digests, nightly reports)

When the user wants something to happen on a schedule — "remind the team
every Friday", "email me a nightly summary", "check X every hour" — declare
it in `appato.json` and handle it in your fetch handler. Never write your
own timer, and never ask the user to trigger it manually.

```json
{
  "org": "acme", "app": "standup-bot",
  "title": "Standup Bot", "description": "...",
  "crons": [
    { "name": "friday-reminder", "schedule": "0 9 * * 5", "tz": "America/Chicago" }
  ]
}
```

- `name` — kebab-case; it's the handler path and the label the user sees.
- `schedule` — standard 5-field cron (`minute hour day-of-month month
  day-of-week`).
- **`tz` — set this whenever the user names a wall-clock time.** It's an
  IANA zone (`America/Chicago`, `Europe/London`). Omitting it means UTC,
  which silently drifts an hour across daylight saving and fires at the
  wrong local time for half the year. Use the user's own timezone; ask if
  you don't know it. Never convert a local time to UTC yourself.
- `path` (optional) — defaults to `/cron/<name>`.

The platform POSTs that path at each fire. Guard it with `requireCron` so
only real scheduled invocations run the job:

```ts
import { requireCron, storage } from "./_appato.js";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/cron/friday-reminder") {
      requireCron(request);          // 404s ordinary visitors
      await storage.push("reminders/", { at: Date.now() });
      // Non-2xx = a failed run. What you RETURN is kept as the run's log
      // and shown in the console and CLI, so say what happened — "ok" tells
      // nobody anything three weeks later.
      return new Response("queued 4 reminders");
    }
    ...
  },
};
```

**Test it immediately — don't wait for Friday.** After pushing, run
`appato cron run friday-reminder`: it fires the job now and prints the
result, including whatever the handler returned — read that to confirm it
did the right thing, not just that it answered 2xx. Then `appato cron` shows
every schedule, its next run, and the last outcome. Do this before telling
the user the schedule works.

Behavior worth knowing (don't rebuild any of it):

- A run that returns non-2xx, errors, or takes over 5 minutes is a failure;
  the console shows it. **10 consecutive failures auto-pause the schedule**
  — fix the handler, push, then `appato cron resume <name>`.
- Runs never overlap: if one is still going when the next fire is due, that
  fire is skipped.
- Missed fires (platform downtime, archived app) are skipped, never
  replayed in a burst. Unarchiving records one `missed` entry covering the
  whole gap so the history explains itself — that entry is a note, not an
  error, and doesn't count toward the auto-pause.
- Pausing/resuming lives in the console and CLI, not the manifest — a push
  won't un-pause something a person deliberately paused. Both need a
  builder seat, same as pushing.
- Schedules are part of the version, so restoring an old version restores
  the schedules that shipped with it. `appato sync` and `appato clone`
  refresh `appato.json`'s `crons` for you — don't hand-edit them to match
  the server, and don't remove entries you didn't mean to delete.
- The handler can tell a real fire from a test: `getCron(request).trigger`
  is `"schedule"` or `"manual"`.
- Plans cap how many schedules an app may have and how often they may run;
  a push that exceeds it fails with the limit in the error.

## Answering "where is my app?"

`appato status` shows the deploy state and URL. Share the URL with the user
when a push succeeds — anyone in their company org can open it.
