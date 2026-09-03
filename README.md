# appato agent plugin

The distributable bundle installed into users' coding agents:

- `skills/appato/SKILL.md` — the workflow (open agent-skills standard; loaded
  by both Claude Code and Codex). Its marked machine-contract reference is
  generated from `cli/src/machine.mjs` by `npm run build:plugin-skill`.
- `bin/appato` + `bin/appato.mjs` — the CLI. Claude Code (>=2.1.91) puts
  plugin `bin/` on the Bash tool's PATH, so `appato` is a bare command with
  no install step; the `.mjs` is generated from `cli/src/` by `npm run
  build:cli` (untracked here; deploy regenerates it before publishing).
  In Codex (no PATH mechanism) the skill installs it to `~/.appato/bin` via
  `node bin/appato.mjs install`. Credentials/state always live in
  `~/.appato/` — never in the plugin dir, which changes on every update.
- `.claude-plugin/plugin.json` — Claude Code plugin manifest
- `.claude-plugin/marketplace.json` — single-repo marketplace manifest; this
  is what lets Codex (and Claude Code, if pointed straight at the repo)
  treat the repo itself as a marketplace
- `.codex-plugin/plugin.json` — Codex plugin manifest
- `hooks/hooks.json` + `hooks/enable-autoupdate.mjs` — Claude Code only. A
  `SessionStart` hook that sets `"autoUpdate": true` on the `appato` entry
  in the user's `extraKnownMarketplaces` (falling back to
  `~/.claude/plugins/known_marketplaces.json` for older Claude Code). Claude
  Code auto-updates third-party marketplaces and their plugins only when that
  flag is set, `/plugin marketplace add` never sets it, and `marketplace.json`
  has no way to declare it — so without the hook every install stays frozen
  at the version current on install day. It touches only the `appato` entry,
  adds the key only when absent (an explicit `false` from the `/plugin`
  toggle is respected), and never fails the session. It runs `async`, so it
  never blocks startup (the cost is one background Node spawn). Plugin hooks
  run at the plugin's trust level, so this adds no permission prompts. Codex has no
  equivalent setting; its plugin manifest ignores `hooks/`.

Pushing is skill-driven (no workflow hooks, by design): the skill instructs the agent
to push after every change and to end each turn stating deploy status
("Deployed to <url>" / "NOT deployed: <reason>"). This keeps behavior
identical across Claude Code and Codex with zero trust prompts. If auto-push
ever becomes worth revisiting, both tools support a PostToolUse hook on
Edit/Write (Codex via apply_patch aliases) that could key off `appato.json`
in the edited file's ancestry.

Publishing: after `npm run deploy`, the deployment workflow runs
`npm run publish:plugin` as a separate, retryable step. Its
`scripts/publish-plugin.mjs` mirrors this directory to
https://github.com/appato-public/appato-plugin — the repo agents clone.
Claude Code discovers it via the catalog the platform worker serves at
`/plugin/marketplace.json` (see `src/plugin-catalog.ts`); Codex clones the
repo directly as a git marketplace.

Install (Claude Code):

```
/plugin marketplace add https://appato.com/plugin/marketplace.json
/plugin install appato@appato
```

Install (Codex):

```
codex plugin marketplace add https://github.com/appato-public/appato-plugin.git
codex plugin add appato@appato
```

## Fewer permission prompts (optional)

Claude Code — one narrow allow rule covers every appato command, and it
survives auto mode (narrow rules resolve before the classifier):

```json
// ~/.claude/settings.json
{
  "permissions": { "allow": ["Bash(appato *)"] },
  "autoMode": {
    "environment": [
      "$defaults",
      "Org-specific CLIs: appato — deploys small internal web apps to appato.com"
    ]
  }
}
```

Codex — experimental rules file (auto-allows only plain-word invocations;
anything with variables or redirects still prompts):

```python
# ~/.codex/rules/default.rules
prefix_rule(
    pattern = ["appato"],
    decision = "allow",
    justification = "appato CLI: deploys internal web apps",
)
```
