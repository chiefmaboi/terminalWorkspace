# Pitwall

A desktop app for running many terminal coding agents side by side. Every terminal in a
workspace is a live tile on one wall; zoom into one to work in it, and see at a glance which
agents are working, idle, or waiting for you.

Works with Claude Code, Codex, or any command-line tool. Windows and macOS.

Pitwall is a fork of [ittop](https://github.com/pottz91/ittop) by pottz91 (MIT).

## Features

- Grid wall of live terminals per workspace, scaled to fit (Auto, or a fixed 0.5 / 0.4 / 0.33 / 0.25).
- Zoom a tile over the dimmed wall; terminals never resize when you zoom, so agent UIs don't reflow.
- Status per terminal: working, idle, or waiting (glowing outline plus a desktop notification).
  Codex reports it on its own output, Claude Code through hooks, anything else from terminal activity.
- Drag tiles to reorder, right-click to pin a tile at 2x2.
- File drawer for the selected terminal, rooted at its current folder (follows worktrees).
- Keyboard driven: arrow keys and Enter on the wall, every key goes to the terminal once inside.

## Getting started

Requirements: Windows 10/11 or macOS, [Node.js](https://nodejs.org/) 20 or newer, and the agents
you want to run (`claude`, `codex`, ...) on your `PATH`.

```bash
npm install
npm run dev                      # run Pitwall with hot reload
PITWALL_DEVTOOLS=1 npm run dev   # same, with DevTools open
```

Create a workspace from the menu at the top left, then add terminals with `+`. Each terminal has a
folder and a start command (default `claude`).

## Agent hooks

Exact status straight from the agent. Claude Code needs them; Codex 0.163 or newer already reports
its status on its own output, so its hooks only add `codex exec` and older versions.

In **Settings > Agent hooks**, click **Install** for Claude Code and/or Codex. Pitwall shows the
exact change to the agent's user-level config (`~/.claude/settings.json`, `~/.codex/hooks.json`)
before writing it, backs the file up, and keeps your other settings and hooks. **Remove** takes it
out again.

The hook only acts inside a Pitwall terminal; sessions started anywhere else are unaffected.
Codex asks you to trust new hooks once: after installing, run `/hooks` in Codex and trust Pitwall's.

## Keys

| Key | Action |
| --- | --- |
| Arrow keys | Move between tiles (when no terminal has focus) |
| Enter | Zoom the selected tile and type into it |
| Ctrl+Shift+Enter | Leave the terminal / zoom from the wall |
| Click / double-click a tile | Type into it / zoom it |
| Esc | Restore a zoomed tile (when focus is not in a terminal) |
| Ctrl+Shift+E | File drawer |
| Ctrl+1 ... Ctrl+9 | Switch workspace |
| ? | All shortcuts |

## Build and test

```bash
npm run build:win    # Windows installer (dist/)
npm run build:mac    # macOS .dmg/.zip, unsigned
npm test             # unit tests
npm run test:e2e     # end-to-end tests (builds first)
```

macOS builds are not notarized: the first time, right-click `Pitwall.app` and choose Open, or run
`xattr -cr /Applications/Pitwall.app`.

## License

[MIT](LICENSE). Pitwall is an independent tool, not affiliated with or endorsed by Anthropic or OpenAI.
