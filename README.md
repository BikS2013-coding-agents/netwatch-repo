# netwatch-repo

The Claude Code plugin marketplace `netwatch`. It holds one plugin of the same name.

## netwatch

A Claude Code mod that records the HTTP calls a web app makes in Chrome while you use it,
shows them live in a pane, and asks the model to explain what happened: the steps you took,
the endpoints called, errors, odd patterns and security concerns.

Chrome is driven through the [`agent-browser`](https://github.com/vercel-labs/agent-browser)
CLI over the Chrome DevTools Protocol, not through Claude in Chrome. The mod therefore works
in every session, whatever the model provider: a claude.ai login, an API key, or a
third-party Anthropic-compatible endpoint such as DeepSeek.

### Commands

| Command | Does |
|---|---|
| `/netwatch start [url]` | Opens agent-browser's own visible Chrome (a clean profile) and starts recording |
| `/netwatch start --connect [url]` | Records in your own running Chrome, with your logins (enable remote debugging once at `chrome://inspect/#remote-debugging`) |
| `/netwatch stop` | Stops recording; the calls are kept |
| `/netwatch report [question]` | Analyses the session in Greek, saved to `~/.claude/netwatch/<time>.md` and `.json` |
| `/netwatch status` | Summary line and opens the pane (the default) |
| `/netwatch clear` | Drops the recorded calls |

It also gives the model the tool `api_log`, so you can ask about the recorded traffic in
plain words.

What it records: method, URL, status, resource type and the time the request was sent.
Scripts, styles, images, fonts and media are counted but left out. Headers and bodies are
never kept, and query values whose names look secret (`token`, `key`, `auth`, …) are masked
before anything reaches the model.

### Requirements

- Claude Code with function-hook mods (2.1.288 or later).
- `agent-browser` on the `PATH` (`npm install -g agent-browser`, then `agent-browser install`).

## Install

```bash
claude plugin marketplace add BikS2013-coding-agents/netwatch-repo
claude plugin install netwatch@netwatch
```

## Developing

On the development machine the plugin is **not installed** from this marketplace. A link
points into this checkout instead:

| Link | → |
|---|---|
| `~/.claude/mods/netwatch` (through `.claude-repo/mods`) | `plugins/netwatch` |

`~/.claude/settings.json` loads that folder in every session through
`"env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/netwatch" }`, and an interactive session
reloads the mod on every save. Installing the plugin as well would load it twice.

```bash
claude plugin validate plugins/netwatch
claude plugin test plugins/netwatch
```

Bump `version` in both `plugins/netwatch/.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json` on every change, or installed copies will not update.
