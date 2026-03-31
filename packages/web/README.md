# @orionomega/web

Next.js 15 web dashboard for OrionOmega with real-time DAG visualization powered by ReactFlow.

---

## Running

```bash
# Development (custom server.mjs + Next.js)
pnpm --filter @orionomega/web dev
# or: node packages/web/server.mjs

# Production build + start
pnpm --filter @orionomega/web build
pnpm --filter @orionomega/web start

# Via CLI (preferred)
orionomega ui start
orionomega ui stop
orionomega ui status
```

The web server proxies WebSocket connections to the gateway, so only one port needs to be exposed to the browser.

---

## Layout

```
┌─────────────────────────────────────────────┐
│  ChatPane (left)    │  OrchestrationPane    │
│                     │  (right, toggleable)  │
│  • Chat messages    │  • DAG visualization  │
│  • Plan approval    │  • Activity feed      │
│  • File attachments │  • Worker detail      │
└─────────────────────┴───────────────────────┘
        ↕ mobile: stacked full-screen panes
```

- **ChatPane** — conversation interface, plan approval cards, file attachment support
- **OrchestrationPane** — tabbed: DAG graph (ReactFlow), activity feed, workflow list
- **Toggle button** — shows/hides the orchestration pane; on mobile, panes are full-screen

---

## Key Modules

### Stores (Zustand)

```ts
import { useOrchestrationStore } from '@/stores/orchestration';
import { useChatStore } from '@/stores/chat';
import { useConnectionStore } from '@/stores/connection';

const { dagMap, workflowOrder } = useOrchestrationStore();
const { messages } = useChatStore();
const { connected, gatewayUrl } = useConnectionStore();
```

### Gateway Client Hook

```ts
import { useGateway } from '@/lib/gateway';

// Mounted once at the app root — manages the WebSocket lifecycle
// and dispatches incoming messages to the Zustand stores.
useGateway();
```

### Sending Messages

```ts
import { sendChatMessage, sendCommand, approvePlan } from '@/lib/gateway';

sendChatMessage('Analyze my codebase');
sendCommand('/stop');
approvePlan(planId);
```

---

## Directory Layout

```
src/
├── app/
│   ├── layout.tsx          # Root layout (Inter font, dark mode, metadata)
│   ├── page.tsx            # Main page — ChatPane + OrchestrationPane split
│   └── globals.css         # CSS variables, Tailwind imports, animations
├── components/
│   ├── chat/               # ChatPane, ChatInput, MessageBubble, PlanCard, etc.
│   └── orchestration/      # OrchestrationPane, DAGViewer, ActivityFeed, etc.
├── lib/
│   ├── gateway.ts          # WebSocket client hook, message dispatch, send helpers
│   ├── uuid.ts             # Client-side UUID generation
│   └── z-index.ts          # Z-index constants (prevents stacking conflicts)
└── stores/
    ├── orchestration.ts    # DAG state, workflow map, node statuses
    ├── chat.ts             # Message list, streaming state
    └── connection.ts       # WebSocket connection state
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Framework | Next.js 15 (App Router) |
| DAG visualization | ReactFlow (`@xyflow/react`) |
| State management | Zustand |
| Styling | Tailwind CSS v4 |
| WebSocket | `reconnecting-websocket` (auto-reconnect) |
| Markdown | `react-markdown` + `rehype-highlight` |
| Virtual scroll | `react-virtuoso` |
| Icons | `lucide-react` |

---

## Architecture Notes

- The web client uses the same gateway WebSocket message protocol as the TUI. Any new event type added to the gateway must be handled in both `packages/tui/src/gateway-client.ts` and `packages/web/src/lib/gateway.ts`.
- The DAG state is normalized in Zustand: `dagMap` is keyed by workflow ID, each value contains the `WorkflowGraph` and per-node statuses.
- `OrchestrationPane` is lazy-loaded (`next/dynamic`) with `ssr: false` — it uses browser APIs (ReactFlow canvas) that cannot render server-side.
- The custom `server.mjs` proxies `/api/gateway/ws` → `ws://127.0.0.1:<port>/ws` so the browser only needs to reach the web server port.

---

## Development

```bash
pnpm --filter @orionomega/web build   # required before first run
pnpm --filter @orionomega/web dev
```

Environment variables (see `.env.example` at repo root):
- `PORT` — web server port (default: 5000)
- `HOST` — bind address (default: 127.0.0.1)
- `NEXT_PUBLIC_APP_VERSION` — injected at build time for display
