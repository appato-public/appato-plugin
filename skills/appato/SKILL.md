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
   succeeds.
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
- `APPATO_DEPLOY_FAILED app=<org>/<slug> version=<n> sha=<12-hex>
  error=<json-string>` — the code was saved but is NOT live; the previous
  version keeps serving. Fix and push again.
- `APPATO_STATUS app=<org>/<slug> deployed_version=<n|none>
  deployed_at=<ms-epoch|never> dirty=<true|false>
  state=<in_sync|behind|modified> sha=<12-hex> url=<url>` — `behind` means
  run `appato sync`; `modified` means unpushed local changes — push.
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
- For state, keep v1 apps stateless or store data client-side; platform
  storage APIs are coming. Do not call external databases unless the user
  provides one.
- Keep apps small and single-purpose. Prefer one screen that does the job
  over navigation and settings pages.

## Answering "where is my app?"

`appato status` shows the deploy state and URL. Share the URL with the user
when a push succeeds — anyone in their company org can open it.
