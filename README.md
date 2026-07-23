# appato agent plugin

The distributable bundle installed into users' coding agents:

- `skills/appato/SKILL.md` — the workflow (open agent-skills standard; loaded
  by both Claude Code and Codex)
Pushing is skill-driven (no hooks, by design): the skill instructs the agent
to push after every change and to end each turn stating deploy status
("Deployed to <url>" / "NOT deployed: <reason>"). This keeps behavior
identical across Claude Code and Codex with zero trust prompts. If auto-push
ever becomes worth revisiting, both tools support a PostToolUse hook on
Edit/Write (Codex via apply_patch aliases) that could key off `appato.json`
in the edited file's ancestry.
- `.claude-plugin/plugin.json` — Claude Code plugin manifest
- `.codex-plugin/plugin.json` — Codex plugin manifest

This directory is the content of the plugin git repo. The marketplace catalog
that points to it is served by the platform worker at
`/plugin/marketplace.json` (see `src/plugin-catalog.ts`).

Publishing (TODO): push this directory to a Cloudflare Artifacts repo exposed
at `https://appato.com/plugin.git` so `/plugin marketplace add
https://appato.com/plugin/marketplace.json` resolves end to end. A public
GitHub repo works as the fallback.

Install (Claude Code):

```
/plugin marketplace add https://appato.com/plugin/marketplace.json
/plugin install appato@appato
```
