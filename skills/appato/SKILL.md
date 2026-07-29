---
name: appato
description: Build and deploy small internal web apps ("utilities") on the appato platform. Use whenever the user asks to build, change, or deploy an appato app, or asks for a small internal tool/utility their team can use. Handles creating the app, writing the code, and keeping it deployed via the appato CLI.
allowed-tools: Bash(appato *)
---

# Building apps on appato

appato hosts small internal-only web apps for the user's company. You write
the code locally; the `appato` CLI deploys it. Apps are live at
`https://<app>-<org>.appato.app` and are only reachable by signed-in
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
   `appato create <slug> --title "PTO Tracker" --description "..."
   --emoji "🌴" --label "PTO"`.
   This creates the `./<slug>/` directory itself — cd in afterward. If the
   slug is taken, the error lists similar existing apps — pick a more
   specific slug informed by that list (e.g. `eng-pto-tracker`), never a
   numbered suffix. If it's unclear whether a similar app already covers
   the need, check `appato status --all` before creating a duplicate.
   A `code=slug_in_trash` error is DIFFERENT: that exact slug is in the
   trash and its name is held until its data is gone. Don't rename around
   it — surface the choice to the user: restore the trashed app
   (`appato restore` from its checkout) or delete it forever
   (`appato delete <slug> --force`), then retry create.
   The title is the human name shown in the workspace; the description is
   1–2 sentences on what the app does and who it's for — write both for the
   user's coworkers, who will discover the app with no other context.
   If a local checkout already exists but its server app does not yet, run
   the same `create` command from the checkout root or its parent. The CLI
   adopts its entire `appato.json` in place, including when the checkout was
   copied from another app; the successful create canonicalizes `org`, `app`,
   `title`, and `description` while preserving every other field. The initial
   push then registers its declared `crons`; no prior server-side cron state
   is implied.
   **Always pass `--emoji` and `--label`** — they design the app's icon (no
   AI is involved; a good pick is on you):
   - `--emoji`: the single emoji that best captures the tool (`"🌴"`,
     `"📊"`, `"🧾"`). Pass a *pair* in one string (`--emoji "📦🚚"`) only
     when one emoji genuinely can't — the two render overlapped. One is
     almost always better.
   - `--label`: one punchy word, ≤ 8 characters, shown under the emoji at
     larger sizes (`"PTO"`, `"Stock"`, `"Rota"`). UTF-8/localized labels are
     fine (counted in graphemes, so 8 CJK characters are legal). Omit it
     only when the emoji alone is clearer than any word.
   Both are overridable later by anyone in the console's icon editor.
   The manifest, `appato.json`:
   - `org` and `app` are the app's identity — never change or delete them.
   - `title` and `description` are yours to maintain: when the app's
     purpose or scope changes, update them in `appato.json` like any other
     file. Every push syncs them to the platform — but they can also be
     edited in the console, so `appato sync` pulls title/description (and
     crons) back down from the platform. Don't be surprised if `sync`
     rewrites them; never edit `org`/`app`.
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
   lost) — then `appato sync` to update the local copy. To inspect a past
   version without checking it out, `appato show <version>` prints its header,
   composition, and file list, and `appato show <version> <path>` prints one
   file; to materialize an old version into a fresh directory (its files and
   its own schedules, ready to sync or push), `appato clone <slug> --version
   <n>`.
8. **When a deployed app misbehaves** — a probe of the app URL fails, the
   user reports a bug, or a response carries the `x-appato-error` header —
   run `appato logs` FIRST, before adding debug endpoints or guessing (it's
   a bounded snapshot that exits immediately; the platform's error page
   tells people to "run appato logs" on purpose). If `errors` > 0 for the
   current deployed version after your push, investigate before ending the
   turn, and mention the finding in your deploy-status statement.
9. **Before ending ANY response where you touched app files, push — and
   state the deploy status explicitly**, using the values from the CLI's
   machine line (below): e.g. "Deployed to <url> (v12, sha 3f9a01c2b4d6)."
   or "⚠ NOT deployed — the last push failed: <reason>." Never end a turn
   leaving the user unsure whether the live app matches what you built. If
   you changed files but cannot push (not logged in, CLI missing), say so
   and tell the user what's needed.
10. **If any appato output mentions an upgrade** (or says the CLI is too
    old), run `appato upgrade`, then retry.

## CLI output contract

The last line(s) of appato commands are machine-readable — space-separated
`key=value` pairs. Parse them; don't scrape the human-readable lines above
them. The compact reference lists each label and its fields; the narrative
below explains what the important results mean.

<!-- machine-contract:start -->
| Token | Fields in wire order |
| --- | --- |
| `APPATO_APP` | `app` `dir` |
| `APPATO_CLONED` | `app` `version` `dir` `url` `existing` |
| `APPATO_CREATED` | `app` `dir` `url` |
| `APPATO_CRON` | `name` `schedule` `tz` `paused` `paused_by` `next_at` `failures` `last_status` |
| `APPATO_CRON_PAUSED` | `app` `name` |
| `APPATO_CRON_RESUMED` | `app` `name` |
| `APPATO_CRON_RUN` | `app` `name` `status` `http` `duration_ms` `error` `output` |
| `APPATO_CRONS` | `app` `count` `suspended` |
| `APPATO_DATA` | `app` `tables` `kv_shared` `kv_readonly` `kv_internal` `people` `size_bytes` `sessions` |
| `APPATO_DELETED` | `app` |
| `APPATO_DEPLOY_FAILED` | `app` `version` `sha` `error` |
| `APPATO_DEPLOYED` | `app` `version` `sha` `url` |
| `APPATO_FILE` | `app` `scope` `key` `found` `size` `type` `by` `at` |
| `APPATO_FILE_DELETED` | `app` `scope` `key` `existed` |
| `APPATO_FILE_LIST` | `app` `scope` `user` `prefix` `count` `truncated` |
| `APPATO_FILE_PUT` | `app` `scope` `key` `size` `type` |
| `APPATO_FILE_SAVED` | `app` `scope` `key` `size` `type` `to` |
| `APPATO_FILES` | `app` `shared` `readonly` `internal` `people` `total` `bytes` |
| `APPATO_INSTALLED` | `version` `path` |
| `APPATO_KEY` | `key` `by` `at` |
| `APPATO_KEYS` | `app` `scope` `user` `prefix` `count` `truncated` |
| `APPATO_KV` | `app` `scope` `key` `found` `by` `at` |
| `APPATO_KV_DELETED` | `app` `scope` `key` `existed` |
| `APPATO_KV_SET` | `app` `scope` `key` |
| `APPATO_LOGIN_PENDING` | `url` `expires_at` |
| `APPATO_LOGS` | `app` `deployed_version` `window_since` `entries` `errors` `error_groups` `stale_errors` `dropped` `client_dropped` `truncated` |
| `APPATO_LOGS_CONSOLE` | `app` `window_since` `entries` |
| `APPATO_PAUSED` | `app` |
| `APPATO_RESTORED` | `app` `url` |
| `APPATO_RESUMED` | `app` `url` |
| `APPATO_ROLLED_BACK` | `app` `version` `restored` `url` |
| `APPATO_SHOW` | `app` `version` `files` |
| `APPATO_SQL` | `app` `rows` `rows_read` `rows_written` `truncated` `write` |
| `APPATO_STATUS` | `app` `deployed_version` `deployed_at` `dirty` `state` `status` `deletes_at` `sha` `url` |
| `APPATO_SYNC_BLOCKED` | `app` `latest_version` `local_sha` |
| `APPATO_SYNCED` | `app` `version` `changed` `files` `sha` |
| `APPATO_TABLE` | `name` `rows` `cols` |
| `APPATO_TRASHED` | `app` `deletes_at` |
| `APPATO_WEBHOOK` | `app` `label` `url` `created_at` `created` |
| `APPATO_WEBHOOK_DELETED` | `app` `label` |
| `APPATO_WEBHOOKS` | `app` `count` |
| `APPATO_WORKSPACE` | `org` `scope` `apps` `checked_out` |
<!-- machine-contract:end -->

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
  state=<in_sync|behind|modified> status=<active|paused|trashed> sha=<12-hex>
  url=<url>` — `behind` means run `appato sync`; `modified` means unpushed
  local changes — push. `status=paused` means the app is offline
  (maintenance): every mutation — push, data write, file write, schedule
  run — is refused with 409. Resume it with `appato resume` (or tell the
  user to resume it from the app's page in the console), then push.
- `APPATO_PAUSED app=<org>/<slug>` — the app is now paused: offline,
  schedules suspended, data frozen but readable. Fully reversible.
- `APPATO_RESUMED app=<org>/<slug> url=<url|none>` — a paused app is active
  again; the last deployed version is redeploying at `url`.
- `APPATO_TRASHED app=<org>/<slug> deletes_at=<ms-epoch|none>` — printed by
  `appato trash`: the app is offline and frozen (like pause) but on a
  countdown to PERMANENT deletion at `deletes_at`. Restore it any time
  before then with `appato restore`. `status=trashed` in `appato status`.
- `APPATO_RESTORED app=<org>/<slug> url=<url|none>` — a trashed app is
  active again; the last deployed version is redeploying at `url`.
- `APPATO_DELETED app=<org>/<slug>` — printed by `appato delete <slug>
  --force`: the app and everything behind it (code, data, files, logs) are
  permanently gone and the slug is freed. Irreversible. `delete` refuses
  without `--force`, and only works on an app already in the trash.
- `APPATO_WORKSPACE org=<org> scope=<mine|all> apps=<n> checked_out=<n>`
  followed by one `APPATO_APP app=<org>/<slug> dir=<"./dir"|none>` per app
  — printed by `status` when outside any app directory. `scope=mine` means
  only the user's own apps are listed (plus local checkouts); rerun with
  `--all` for the org-wide list.
- `APPATO_CREATED app=<org>/<slug> dir=<json-string> url=<url>` — app
  created; its directory is `dir`.
- `APPATO_CLONED app=<org>/<slug> version=<n> dir=<json-string> url=<url>`
  — checkout created (or `existing=true` if it was already there). `version`
  is the version checked out: the latest, or the past snapshot named by
  `appato clone <slug> --version <n>`.
- `APPATO_SHOW app=<org>/<slug> version=<n> files=<n>` — printed by
  `appato show [version]` (no path): the version's header, composition, and
  file list are the human lines above it. Reads one version WITHOUT checking
  it out; `version` defaults to the latest. `appato show <version> <path>`
  instead writes that one file's bytes to stdout (or to `-o <path>`) with no
  machine line, so the output stays the pure file. There is deliberately no
  `appato diff` — compose a diff from two `show`/`clone` outputs.
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
  by one `APPATO_CRON name=<json-string> schedule=<json-string> tz=<zone>
  paused=<true|false> paused_by=<user|auto|none> next_at=<ms-epoch|none>
  failures=<n> last_status=<ok|error|timeout|skipped|missed|running|never>`
  per schedule. `paused_by=auto` means the platform stopped it after
  repeated failures — fix the handler, push, then
  `appato cron resume <name>`. `missed` is NOT a failure and needs no fix:
  the app was paused, so those fires never happened and are never
  replayed.
- `APPATO_CRON_RUN app=<org>/<slug> name=<json-string>
  status=<ok|error|timeout|skipped> http=<code|none> duration_ms=<n>
  error=<json-string> output=<json-string>` — result of `appato cron run`.
  Non-`ok` exits 2 (`skipped` means a previous run was still in flight —
  retry shortly). `output` is what the handler RETURNED on success (its
  response body, capped) — check it to confirm the job did the right thing,
  not merely that it answered 2xx. Empty for failures, whose body is folded
  into `error` instead.
- `APPATO_CRON_PAUSED app=<org>/<slug> name=<json-string>` /
  `APPATO_CRON_RESUMED app=<org>/<slug> name=<json-string>` — result of `appato
  cron pause|resume <name>`. Pausing is runtime state that survives
  pushes: a later deploy will NOT silently resume a paused schedule.
- `APPATO_WEBHOOK app=<org>/<slug> label=<json-string> url=<json-string>
  created_at=<ms> [created=<true|false>]` — one provisioned capability.
  `created` appears after `webhook create`; false means the existing URL was
  returned idempotently. Treat `url` as a secret and load the
  `appato-webhooks` skill before implementing or configuring it.
- `APPATO_WEBHOOKS app=<org>/<slug> count=<n>` follows the per-hook lines from
  `appato webhook`. `APPATO_WEBHOOK_DELETED app=<org>/<slug>
  label=<json-string>` confirms immediate revocation.
- `APPATO_LOGS app=<org>/<slug> deployed_version=<n|none> window_since=<ms>
  entries=<n> errors=<n> error_groups=<n> stale_errors=<n> dropped=<n>
  client_dropped=<n> truncated=<true|false>` — printed by `appato logs`.
  `stale_errors` counts errors from versions older than the deployed one —
  pre-fix ghosts; ignore them unless they recur on the current version.
  `client_dropped` totals the events the browser SDK dropped before sending
  (dedup, rate caps — summed from the window's client_report events).
  Nonzero `dropped`, nonzero `client_dropped`, or `truncated=true` means
  the picture is incomplete — say so rather than guessing at what's
  missing.
- `APPATO_LOGS_CONSOLE app=<org>/<slug> window_since=<ms> entries=<n>` —
  printed by `appato logs --console`: raw server `console.log` output from
  the ~7-day firehose (default window 1h; `--since 24h` reaches back). Use
  it when the durable timeline shows an error but you need the app's own
  print-debugging output around it.

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
- **Non-code files are served at their path** — put images, fonts, CSS or
  other assets in the app directory and reference them the way you would
  anywhere else (`<img src="/logo.png">`). A shipped `.html` file serves at
  its path with standard static-site behavior (`index.html` at `/`,
  `page.html` at `/page`), shadowing your fetch handler for that path.
- `./_appato.js` is injected by the platform at deploy time — import it, but
  never create that file.
- If the app must receive public third-party callbacks that cannot use member
  SSO, also load the `appato-webhooks` skill. Keep webhook mechanics out of
  ordinary authenticated `fetch` routes.
- For state, use the built-in storage + realtime APIs (next section). Do not
  call external databases unless the user provides one.
- The `/_appato/*` URL path is reserved by the platform — your fetch handler
  never sees it; don't route on it.
- **The app's icon is served for you** — the one you set with `--emoji` /
  `--label` at create (editable in the console). The platform answers
  `/favicon.ico` and `/apple-touch-icon.png` automatically for every app, so a
  browser tab and an iOS home-screen bookmark already show the right icon with
  zero markup. Ladder PNGs live at reserved paths too: `/_appato/icon-192.png`
  and `/_appato/icon-512.png` (also 16/32/48/180/256). If you add a PWA
  `manifest.json`, point its `icons` at those. You don't need `<link
  rel="icon">` tags, but adding them (e.g. `<link rel="icon" sizes="any"
  href="/favicon.ico">`) is harmless and lets a browser pick a specific size.
- Keep apps small and single-purpose. Prefer one screen that does the job
  over navigation and settings pages.
- **The URL is part of the UI.** When the app does have distinct views —
  tabs, a selected item, a filter that changes what's on screen — put the
  view in the URL and keep it updated as the user navigates, so back,
  refresh, and a pasted link all land on the same view. A few lines of
  `history.pushState` + one `popstate` listener is enough — no router
  library. Have the fetch handler serve the app shell for every view path
  so deep links survive a reload (an app that's a single static
  `index.html` can use `#/...` hash paths instead). Prefer human-readable
  slugs over opaque ids: `/polls/lunch-spot`, not `/poll?id=8f3a2c`.
## Shared data & realtime

Every app has a private, zero-setup data store and realtime hub — no
provisioning, no credentials, no npm. (`appato sdk` prints this whole
reference — API surface, tiers, recipes, limits — whenever you need it.)
**Every read and write names a scope.** There is no unscoped store — you
pick who the data belongs to on every call, and the platform enforces it
using the identity it already verified. You never write an auth check for
this, and there is no way to reach another scope by spelling a clever key.

| scope | who can read | who can write | reach for it when |
|---|---|---|---|
| `shared` | every org member | every org member | **the default.** Team data: messages, votes, rows, settings |
| `mine` | just that person | just that person | the key belongs to ONE human: drafts, personal settings, a private checklist |
| `readonly` | every org member | **your server only** | derived or authoritative data clients must not forge: leaderboards, computed summaries, config |
| `internal` | **your server only** | your server only | browsers must never see it: API keys, audit logs, working state |

Choosing is one question: **whose data is this?** If it's the team's,
`shared`. If it's one person's, `mine`. If your server computes it, ask
whether the browser should see it — `readonly` if yes, `internal` if no.

Nothing typechecks an app for you, so this table and `appato sdk` are the
contract — a scope or verb that isn't in them doesn't exist, and calling one
throws when that line runs.

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

const { shared, readonly, internal } = storage;

await shared.set("polls/lunch", { question: "Where?", options: ["a", "b"] });
const poll = await shared.get("polls/lunch");         // undefined if missing
const key = await shared.push("messages/", { text }); // appends with a
    // server-assigned time-sortable id → keys sort chronologically
const n = await shared.increment("votes/pizza");      // atomic counter
const msgs = await shared.list("messages/", { limit: 50, reverse: true });
    // -> [{ key, value, by, at }]  — `by` is the verified writer, or null
await shared.delete("polls/old");

await readonly.set("stats", computed);   // browsers read this, can't change it
await internal.set("apiKey", secret);    // browsers never see this at all

await publish("refresh", { reason: "new data" });      // ephemeral broadcast

// One person's private keys — the same data their browser sees as
// `storage.mine`. Only the server can reach someone ELSE's, so approver
// views, digests and exports go here, behind your own check.
const drafts = await storage.forUser(user.id).list("drafts/");
```

Keys are plain strings, relative to their scope; use `/`-separated prefixes
as collections (`messages/`, `votes/`). Values are JSON (≤128KB each; ~100MB
per app on the default plan — the store cap is plan-dependent). Nothing is
reserved — the same key in two scopes is two different values.

**SQL** for structured data (reports, joins, aggregates) — the app's own
private SQLite. **Server-side only**: call it in your fetch handler and
serve the result from your own route. It is not available in the browser.

```ts
await storage.sql("CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY, who TEXT, amount REAL)");
await storage.sql("INSERT INTO expenses (who, amount) VALUES (?, ?)", [user.id, 12.5]);
const { rows } = await storage.sql("SELECT who, SUM(amount) AS total FROM expenses GROUP BY who");
await storage.sqlBatch([{ query: "...", params: [] }, { query: "..." }]); // one transaction
```

Table names prefixed `_appato_` are reserved. Rule of thumb: **KV + `watch`
for anything live on screen; SQL only for what KV can't do** — aggregates,
joins, sorting by a value, more than ~500 rows. SQL tables emit NO realtime
change events, so a SQL-backed screen has to re-fetch to update. Most small
apps need no SQL at all.

**Browser side** — in the HTML your app serves, import the client SDK (it
knows the signed-in user; never build login or ask who the user is):

```html
<script type="module">
  import { appato } from "/_appato/client.js";

  appato.user;                            // { id, email, name, org } — verified
  const { shared, mine, readonly } = appato.storage;
      // same verbs as the server, per scope. `internal`, `sql` and `forUser`
      // are absent here — they are server-only, so calling one is an error
      // you see immediately rather than a request that gets rejected.

  // Live view: cb fires with all entries under the prefix, immediately and
  // on every change (snapshot semantics — reconnects re-sync automatically).
  // `watch` is a verb on each scope, so a subscription never mixes them.
  shared.watch("messages/", (entries) => {
    // entries: [{ key, value, by, at }] sorted by key (push keys =
    // chronological). `at` is the write time (always set). `by` is the
    // platform-verified writer — { id, name } for a person, or NULL when
    // the app's own server wrote the row, so always handle null. NEVER
    // store your own "author" field for this: a browser can put anyone's
    // name in a value, but it cannot forge `by`.
    render(entries.map((e) => (e.by ? e.by.name : "system") + ": " + e.value.text));
  });

  await shared.push("messages/", { text });   // anyone on the team can post
  await mine.set("draft", text);              // only this person, ever
  readonly.watch("stats", renderStats);       // server writes it; we display it

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

Recipes: **chat** = `shared.push` + `shared.watch` + presence · **poll /
tracker** = `shared.increment`/`set` + `watch` · **dashboard** =
`readonly.watch` (+ server `publish` for ticks) · **per-user drafts or
settings** = `mine.set` + `mine.watch` · **cursors / typing** = `channel`
broadcast only.

`watch` is for prefixes with ≤500 entries (it delivers a full snapshot);
paginate bigger data with `list`/SQL. **Design keys so a watched prefix stays
under 500** — shard by date, room, or owner (`messages/2026-07/…`,
`room/<id>/…`) rather than one flat `messages/` that grows without bound; a
snapshot clipped at 500 warns in the browser console but silently shows a
partial view. Writes from any tab, the server, or a coworker's browser all fan
out to every watcher in that scope — you never need polling, WebSocket code,
reconnect handling, or a version check.

## File uploads (images, PDFs, exports)

`storage` holds JSON (≤128KB); **files** hold blobs — avatars, photos,
generated PDFs, CSV exports. Files use the **same scopes as storage** and the
same rule (the platform enforces who can reach what, using the identity it
verified), so there are no signed or unguessable URLs to manage.

| scope | who can read | who can write | reach for it when |
|---|---|---|---|
| `shared` | every org member | every org member | team files: a shared photo wall, uploaded docs everyone edits |
| `mine` | just that person | just that person | one human's file: their avatar, a personal upload |
| `readonly` | every org member | **your server only** | files your server produces for everyone to download: a generated report |
| `internal` | **your server only** | your server only | files a browser must never load directly: attachments gated by your own check |

Verbs, per scope (keys are strings, relative to the scope):

- `put(key, body, { contentType }?)` → `{ key, url }`. Server body is a
  string, ArrayBuffer, Blob, or ReadableStream; browser body is a `File`/`Blob`.
  contentType defaults to `file.type` when the blob has one, else
  `application/octet-stream` (which downloads as an attachment).
- `get(key)` → the **fetch `Response` itself**, hardened headers included, or
  `undefined` if missing — so you can serve it straight back.
- `delete(key)`, and `list(prefix, { cursor, limit }?)` →
  `{ files: [{ key, size, contentType, by, at }], cursor? }`.
- `url(key)` → an app-relative path a browser can load. It exists **only where
  a browser could actually load the result**: server `shared`/`readonly`, and
  browser `shared`/`mine`/`readonly`. `internal` and `forUser` have no `url()`
  — no URL can carry server-only or cross-user authority, so the method is
  simply absent (calling it throws). A `mine` URL is the same string for
  everyone and resolves to **each viewer's own file**.

Every served file carries `nosniff` + a `Content-Security-Policy: sandbox`, so
even a mis-typed HTML or SVG upload can't script your app. Limits (default
plan, plan-dependent): **25MB per file, ~1GB per app, 1000 files**.

**Server** (`./_appato.js`):

```ts
import { files } from "./_appato.js";

const { key } = await files.shared.put("logo.png", bytes, { contentType: "image/png" });
const list = await files.shared.list("photos/");  // { files: [{ key, size, contentType, by, at }] }
const doc = await files.forUser(user.id).get("resume.pdf");  // one person's file (no `mine` server-side)
return await files.readonly.get("nightly-report.pdf");  // serve a server-produced file straight back
```

**Browser** (in your served HTML):

```html
<script type="module">
  import { appato } from "/_appato/client.js";

  // Upload the file the user picked; contentType defaults to file.type.
  const file = input.files[0];
  const { url } = await appato.files.mine.put("avatar", file);
  img.src = url;                                  // same-origin; loads with the session cookie

  // Show the team's shared photos without downloading them in JS.
  const { files } = await appato.files.shared.list("photos/");
  gallery.innerHTML = files.map((f) => '<img src="' + appato.files.shared.url(f.key) + '">').join("");
</script>
```

**Attachments only some people may see** = `files.internal` + your own route.
Store the blob in `internal` (no URL can reach it), then gate a serving route
with your own check and hand back the Response `get` returns:

```ts
// index.ts — a DM attachment, visible to its two participants only
if (url.pathname.startsWith("/att/")) {
  const me = requireUser(request);
  const dm = await storage.internal.get("att/" + url.pathname.slice(5));
  if (!dm || (me.id !== dm.from && me.id !== dm.to)) return new Response("forbidden", { status: 403 });
  return (await files.internal.get(dm.fileKey)) ?? new Response("gone", { status: 404 });
}
```

The broken image a 403 produces is the point: access fails **closed and
visibly**, and removing someone from the workspace cuts it instantly — neither
is true of a shareable file URL.

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
      await storage.shared.push("reminders/", { at: Date.now() });
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
- Missed fires (platform downtime, paused app) are skipped, never
  replayed in a burst. Resuming records one `missed` entry covering the
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

## App data (inspecting and fixing what the app stored)

`appato data` is the operator view over the app's own storage — the same KV
and SQL the app uses, seen from outside the scope rules. Reach for it when
you need to see what the app actually stored, fix a bad value, run a small
one-off migration, or debug "why is the UI showing X" — look at the data
FIRST, before adding debug endpoints or guessing. Every edit made this way
(and every read of someone else's personal data) is attributed to the
signed-in user and logged to the app's Logs, so coworkers can see who
changed what — edit deliberately.

- `appato data` — overview: SQL tables with row counts, key counts per
  scope, people with personal data, storage size, live sessions.
- `appato data ls [prefix] [--scope ...] [--user <id|email>]` — list keys.
- `appato data get|rm <key> [--scope ...] [--user ...]` — read / delete one
  value.
- `appato data set <key> <value|-> [--scope ...] [--user ...]` — write one
  value: parsed as JSON if it parses, kept as a plain string otherwise
  (`set greeting hello` and `set config '{"x":1}'` both do the obvious
  thing); `-` reads the value from stdin.
- `appato data sql "<statement>" [--write] [--json]` — one SQL statement
  against the app's private SQLite. **Read-only by default**: a statement
  that would write (or change the schema) is refused with an error — re-run
  with `--write` to apply. `_appato_` tables are reserved (the platform's
  own; use the kv verbs for KV). Results cap at 500 rows
  (`truncated=true`). **One statement per call** — never join statements
  with semicolons. With no statement it reads one statement from stdin, or
  opens an interactive REPL on a TTY (`.help` lists its dot-commands) — the
  REPL is for humans; as an agent, pass the statement as the argument.

`--scope` (default `shared`) names the same scopes as the storage table
above: `shared` (team data) · `readonly` (server-computed, member-visible) ·
`internal` (server-only) · `mine` (one person's own data). `--user
<id|email>` says whose `mine` data — required with `--scope mine`, invalid
with any other scope; an email resolves against the people who actually
have data (the error lists them if it doesn't match).

Machine lines:

- `APPATO_DATA app=<org>/<slug> tables=<n> kv_shared=<n> kv_readonly=<n>
  kv_internal=<n> people=<n> size_bytes=<n> sessions=<n>` followed by one
  `APPATO_TABLE name=<json-string> rows=<n> cols=<json-string>`
  per SQL table — printed by bare `appato data`.
- `APPATO_KEYS app=<org>/<slug> scope=<scope> user=<id|none>
  prefix=<json-string> count=<n> truncated=<true|false>` followed by one
  `APPATO_KEY key=<json-string> by=<json-string|null> at=<ms-epoch>` per
  key — printed by `ls`. `by=null` means the app's own server wrote it.
  `truncated=true` means more keys exist — narrow with a prefix.
- `APPATO_KV app=<org>/<slug> scope=<scope> key=<json-string>
  found=<true|false> by=<json-string|null> at=<ms-epoch>` — printed by
  `get`; the pretty-printed JSON value is everything above the line.
  `found=false` (no `by`/`at`) exits 1.
- `APPATO_KV_SET app=<org>/<slug> scope=<scope> key=<json-string>` — the
  write landed.
- `APPATO_KV_DELETED app=<org>/<slug> scope=<scope> key=<json-string>
  existed=<true|false>` — delete is idempotent; `existed` says whether
  anything was there.
- `APPATO_SQL app=<org>/<slug> rows=<returned> rows_read=<n>
  rows_written=<n> truncated=<true|false> write=<true|false>` — printed
  after every non-REPL `appato data sql` statement (with `--json` too, after
  the result JSON). A refused statement (e.g. a write without `--write`)
  prints the server's error and exits 1 instead.

## App files (inspecting an app's uploads)

`appato files` is the file twin of `appato data` — the operator view over the
app's uploaded blobs (images, PDFs, exports), the same R2-backed file plane
the app's SDK uses, seen from outside the scope rules. Reach for it to see
what the app actually stored, download a file to check it, replace a bad
upload, or clear one out. Like the data tool, reads and writes need a builder
seat, and every upload, delete, and read of someone else's personal (`mine`)
files is attributed to the signed-in user and logged to the app's Logs.

- `appato files` — overview: file count + bytes per scope, people with
  personal files, quota used.
- `appato files ls [prefix] [--scope ...] [--user <id|email>]` — list files.
- `appato files get <key> [-o <path>] [--scope ...] [--user ...]` — download
  one file to `<path>` (or to stdout when piped; a bare TTY without `-o` is
  refused — binary would garble the terminal).
- `appato files put <path> [<key>] [--scope ...] [--user ...] [--type <mime>]`
  — upload a local file. Key defaults to the file's basename; content type is
  inferred from the extension unless `--type` says otherwise. Per-file cap 25MB.
- `appato files rm <key> [--scope ...] [--user ...]` — delete one file.

`--scope` and `--user` mean exactly what they do for `appato data` (default
`shared`; `mine` needs `--user`, invalid elsewhere; an email resolves against
the people who actually have files).

Machine lines:

- `APPATO_FILES app=<org>/<slug> shared=<n> readonly=<n> internal=<n>
  people=<n> total=<n> bytes=<n>` — printed by bare `appato files`.
- `APPATO_FILE_LIST app=<org>/<slug> scope=<scope> user=<id|none>
  prefix=<json-string> count=<n> truncated=<true|false>` followed by one
  `APPATO_FILE key=<json-string> size=<n> type=<json-string> by=<json-string|null>
  at=<ms-epoch>` per file — printed by `ls`. `by=null` means the app's own
  server wrote it. `truncated=true` means more files exist — narrow with a
  prefix.
- `APPATO_FILE app=<org>/<slug> scope=<scope> key=<json-string> found=false`
  — printed by `get` on a miss (exits 1).
- `APPATO_FILE_SAVED app=<org>/<slug> scope=<scope> key=<json-string>
  size=<n> type=<json-string> to=<json-string|stdout>` — printed by `get` on
  success; `to` is the output path, or `stdout` when piped. With `-o` this
  line is on stdout; when the bytes stream to stdout it's on **stderr**
  instead, so the piped file bytes stay clean.
- `APPATO_FILE_PUT app=<org>/<slug> scope=<scope> key=<json-string> size=<n>
  type=<json-string>` — the upload landed.
- `APPATO_FILE_DELETED app=<org>/<slug> scope=<scope> key=<json-string>
  existed=<true|false>` — delete is idempotent; `existed` says whether
  anything was there.

## Answering "where is my app?"

`appato status` shows the deploy state and URL. Share the URL with the user
when a push succeeds — anyone in their company org can open it.
