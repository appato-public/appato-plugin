# appato agent plugin

The distributable bundle installed into users' coding agents:

- `skills/appato/SKILL.md` — the workflow (open agent-skills standard; loaded
  by both Claude Code and Codex)
- `bin/appato.mjs` — bundled copy of the CLI, the last-resort fallback when
  installing to `~/.appato/bin` fails (synced from `cli/` by `npm run sync:cli`)
- `.claude-plugin/plugin.json` — Claude Code plugin manifest
- `.claude-plugin/marketplace.json` — single-repo marketplace manifest; this
  is what lets Codex (and Claude Code, if pointed straight at the repo)
  treat the repo itself as a marketplace
- `.codex-plugin/plugin.json` — Codex plugin manifest

Pushing is skill-driven (no hooks, by design): the skill instructs the agent
to push after every change and to end each turn stating deploy status
("Deployed to <url>" / "NOT deployed: <reason>"). This keeps behavior
identical across Claude Code and Codex with zero trust prompts. If auto-push
ever becomes worth revisiting, both tools support a PostToolUse hook on
Edit/Write (Codex via apply_patch aliases) that could key off `appato.json`
in the edited file's ancestry.

Publishing: `scripts/publish-plugin.mjs` (runs as part of `npm run deploy`)
mirrors this directory to https://github.com/appato-public/appato-plugin —
the repo agents clone. Claude Code discovers it via the catalog the platform
worker serves at `/plugin/marketplace.json` (see `src/plugin-catalog.ts`);
Codex clones the repo directly as a git marketplace.

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
