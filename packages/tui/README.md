# @orionomega/tui

Terminal UI for OrionOmega, built on [pi-tui](https://github.com/mariozechner/pi-tui) — an imperative component tree with differential rendering optimized for terminal output.

---

## Running

```bash
# After building
node packages/tui/dist/index.js

# Via CLI (preferred)
orionomega

# Development (tsx watch)
pnpm --filter @orionomega/tui dev
```

The TUI connects to the gateway WebSocket at startup (`ws://127.0.0.1:<port>/ws?client=tui`). The gateway port is read from `~/.orionomega/config.yaml`.

---

## Layout

```
┌──────────────────────────────────────┐
│ StatusBar    [model] [tokens] [cost] │
├──────────────────┬───────────────────┤
│                  │                   │
│    ChatLog       │  WorkflowPanel    │
│                  │  (DAG tree view)  │
│                  │                   │
├──────────────────┴───────────────────┤
│ CustomEditor  (input + autocomplete) │
└──────────────────────────────────────┘
```

- **ChatLog** — scrollable ring buffer of assistant and user messages, rendered as Markdown
- **WorkflowPanel** — tree view of running/completed workflows with per-node status and timing
- **StatusBar** — current model, token counts, session cost, Hindsight connection indicator
- **CustomEditor** — multi-line input with slash command autocomplete

---

## Slash Commands

All slash commands are sent to the gateway as `{ type: 'command', command: '/stop' }` messages:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/workflows` | List all active workflows |
| `/status` | Session and system status |
| `/stop` | Stop the active workflow |
| `/pause` | Pause before the next execution layer |
| `/resume` | Resume a paused workflow |
| `/plan` | Show the current execution plan |
| `/workers` | List active workers |
| `/gates` | List pending human approval gates |
| `/skills` | View, enable/disable, configure skills |
| `/reset` | Clear history and detach from current workflow |
| `/restart` | Restart the gateway service |
| `/update` | Pull latest, rebuild, and restart |
| `/focus` | Focus a specific workflow by ID |
| `/hindsight` | Show Hindsight memory status |
| `/exit` / `/quit` | Exit the TUI |

---

## Directory Layout

```
src/
├── index.ts              # Entry point — TUI setup, gateway connect, event loop
├── gateway-client.ts     # WebSocket client (plain class, no React)
├── theme.ts              # Colours, icons, spacing, Markdown theme
├── utils/
│   └── format.ts         # formatDuration, formatTokens, formatCost
└── components/
    ├── chat-log.ts        # Scrollable message ring buffer
    ├── chat-log-entry.ts  # Per-message component
    ├── context-line.ts    # Reply-to context reference
    ├── custom-editor.ts   # Multi-line input with autocomplete
    ├── layer-group.ts     # Node group within a workflow layer
    ├── node-display.ts    # Individual node status display
    ├── omega-spinner.ts   # Animated spinner for in-progress nodes
    ├── plan-overlay.ts    # Plan approval/rejection overlay
    ├── status-bar.ts      # Top status bar
    └── workflow-panel.ts  # Full workflow tree panel
```

---

## Architecture Notes

- The TUI shares the same gateway WebSocket event protocol as the Web UI. When new event types are added to the gateway, both UIs need to handle them.
- `GatewayClient` is a plain `EventEmitter` — not React. The pi-tui framework handles rendering imperatively via `component.update()` calls, not reconciliation.
- `ChatLog` uses a capped ring buffer (`maxEntries = 200`) to avoid unbounded memory growth on long sessions.
- Plan approval flow is handled inline in the chat log — the plan overlay renders inside the chat stream and resolves via `client.approvePlan()` / `client.rejectPlan()`.

---

## Development

```bash
pnpm --filter @orionomega/tui build
pnpm --filter @orionomega/tui dev    # tsx --watch
```
