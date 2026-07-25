/**
 * @module ws-contract
 * Zod-derived WebSocket protocol contract shared between the gateway (server)
 * and the web frontend (client).
 *
 * The gateway authors the canonical `ServerMessage` interface in
 * `packages/gateway/src/types.ts`; this module mirrors the *wire shape* of the
 * server → client envelope as runtime Zod schemas and derives the matching
 * TypeScript types via `z.infer`. The web client consumes the derived types so
 * the loose `any` / `Record<string, unknown>` typing on incoming messages and
 * reconnection snapshots can be removed, while runtime validation and the
 * compile-time types stay in agreement.
 *
 * The envelope schema is intentionally permissive (`.passthrough()`, all
 * payload fields optional) so it accepts every concrete message variant the
 * gateway emits without coupling the two packages to an exact field-by-field
 * union. It additionally models a handful of fields the frontend reads
 * defensively (`metadata`, `toolName`, `name`, `count`, `message`) that are
 * forwarded from underlying worker/tool events but not enumerated on the
 * gateway interface.
 */

import { z } from 'zod';

// ── Reusable leaf schemas ─────────────────────────────────────────────────────

/** Per-model token/cost usage, shared by `dag_complete` and `direct_complete`. */
export const modelUsageSchema = z.object({
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  workerCount: z.number(),
  costUsd: z.number(),
});

/**
 * Memory activity status. Reports what memory can currently *do* — never
 * whether a socket is open. `health` is the operator-facing rollup:
 * `ready` (serving recall), `rebuilding` (index warming, see `pct`),
 * `degraded` (recall unavailable or lossy, see `reason`).
 */
export const memoryActivitySchema = z.object({
  busy: z.boolean(),
  health: z.enum(['ready', 'rebuilding', 'degraded']),
  pct: z.number().optional(),
  reason: z.enum(['redis_unreachable', 'index_cold', 'write_failed']).optional(),
  op: z.string().optional(),
  count: z.number().optional(),
});

/** A single memory event row. */
export const memoryEventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  op: z.string(),
  detail: z.string(),
  scope: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/** Session token/cost status banner. */
export const sessionStatusSchema = z.object({
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  maxContextTokens: z.number(),
  sessionCostUsd: z.number().optional(),
});

/** Result of a slash command. */
export const commandResultSchema = z.object({
  command: z.string(),
  success: z.boolean(),
  message: z.string(),
});

/** Live thinking-step row. */
export const stepSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['pending', 'active', 'done']),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  elapsedMs: z.number().optional(),
  detail: z.string().optional(),
});

/** A persisted history message row. */
export const historyMessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string(),
  timestamp: z.string(),
  type: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** Optional usage metadata attached to streamed `text` messages. */
export const messageMetadataSchema = z
  .object({
    model: z.string().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    costUsd: z.number().optional(),
  })
  .passthrough();

/**
 * Wire shape of a scheduled task row (mirrors `ScheduledTask` in
 * `@orionomega/core`). Mirrored here (not imported) to keep `@orionomega/shared`
 * free of any dependency on `core`, which itself depends on shared.
 */
export const scheduledTaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  cronExpr: z.string(),
  prompt: z.string(),
  agentMode: z.enum(['orchestrate', 'direct', 'code']),
  sessionId: z.string(),
  status: z.enum(['active', 'paused', 'deleted']),
  timezone: z.string(),
  overlapPolicy: z.enum(['skip', 'queue', 'allow']),
  maxRetries: z.number(),
  timeoutSec: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  runCount: z.number(),
  runAt: z.string().nullable(),
  attachments: z
    .array(
      z.object({
        name: z.string(),
        size: z.number(),
        type: z.string(),
        data: z.string().optional(),
        textContent: z.string().optional(),
      }),
    )
    .nullable()
    .optional(),
});

// ── DAG lifecycle payloads ────────────────────────────────────────────────────

export const dagDispatchSchema = z.object({
  workflowId: z.string(),
  workflowName: z.string(),
  nodeCount: z.number(),
  estimatedTime: z.number(),
  estimatedCost: z.number(),
  summary: z.string(),
  nodes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      type: z.string(),
      dependsOn: z.array(z.string()).optional(),
    }),
  ),
});

export const dagProgressSchema = z.object({
  workflowId: z.string(),
  nodeId: z.string(),
  nodeLabel: z.string(),
  status: z.enum(['started', 'progress', 'done', 'error']),
  message: z.string().optional(),
  progress: z.number().optional(),
  layerProgress: z.object({ completed: z.number(), total: z.number() }).optional(),
  tool: z
    .object({
      name: z.string(),
      action: z.string().optional(),
      file: z.string().optional(),
      summary: z.string().optional(),
    })
    .optional(),
  workerId: z.string().optional(),
});

export const dagCompleteSchema = z.object({
  workflowId: z.string(),
  status: z.enum(['complete', 'error', 'stopped']),
  summary: z.string(),
  output: z.string().optional(),
  findings: z.array(z.string()).optional(),
  outputPaths: z.array(z.string()).optional(),
  nodeOutputPaths: z.record(z.string(), z.array(z.string())).optional(),
  durationSec: z.number(),
  workerCount: z.number(),
  totalCostUsd: z.number(),
  toolCallCount: z.number().optional(),
  modelUsage: z.array(modelUsageSchema).optional(),
});

export const dagConfirmSchema = z.object({
  workflowId: z.string(),
  summary: z.string(),
  reasoning: z.string(),
  estimatedCost: z.number(),
  estimatedTime: z.number(),
  nodes: z.array(z.object({ id: z.string(), label: z.string(), type: z.string() })),
  guardedActions: z.array(z.string()),
});

export const gateRequestSchema = z.object({
  gateId: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  action: z.string(),
  description: z.string(),
  timestamp: z.string(),
});

export const gateResolvedSchema = z.object({
  gateId: z.string(),
  workflowId: z.string(),
  resolution: z.enum(['approved', 'denied', 'expired']),
  timestamp: z.string(),
});

// Task #234: human-in-the-loop manual-intervention requests, keyed by nodeId.
export const interventionRequestSchema = z.object({
  interventionId: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  nodeId: z.string(),
  nodeLabel: z.string(),
  prompt: z.string(),
  timestamp: z.string(),
});

export const interventionResolvedSchema = z.object({
  interventionId: z.string(),
  workflowId: z.string(),
  nodeId: z.string(),
  timestamp: z.string(),
});

// ── Coding-mode event payloads (discriminated union by `type`) ─────────────────

export const codingEventPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('coding:session:started'),
    payload: z.object({ repoUrl: z.string(), branch: z.string(), sessionId: z.string() }),
  }),
  z.object({
    type: z.literal('coding:workflow:started'),
    payload: z.object({ workflowId: z.string(), template: z.string(), nodeCount: z.number() }),
  }),
  z.object({
    type: z.literal('coding:step:started'),
    payload: z.object({ nodeId: z.string(), label: z.string(), type: z.string() }),
  }),
  z.object({
    type: z.literal('coding:step:progress'),
    payload: z.object({
      nodeId: z.string(),
      message: z.string(),
      percentage: z.number(),
      activeAgents: z.number().optional(),
      totalAgents: z.number().optional(),
      tokensUsed: z.number().optional(),
      costUsd: z.number().optional(),
    }),
  }),
  z.object({
    type: z.literal('coding:step:completed'),
    payload: z.object({ nodeId: z.string(), status: z.literal('success'), outputSummary: z.string() }),
  }),
  z.object({
    type: z.literal('coding:step:failed'),
    payload: z.object({ nodeId: z.string(), error: z.string() }),
  }),
  z.object({
    type: z.literal('coding:review:started'),
    payload: z.object({ iteration: z.number() }),
  }),
  z.object({
    type: z.literal('coding:review:completed'),
    payload: z.object({
      decision: z.enum(['approve', 'reject', 'request-changes']),
      feedback: z.string(),
      metrics: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  z.object({
    type: z.literal('coding:commit:completed'),
    payload: z.object({ commitHash: z.string(), branch: z.string() }),
  }),
  z.object({
    type: z.literal('coding:session:completed'),
    payload: z.object({
      summary: z.string(),
      filesModified: z.array(z.string()).optional(),
      filesCreated: z.array(z.string()).optional(),
      totalDurationMs: z.number().optional(),
    }),
  }),
]);

// ── Scheduler payloads ────────────────────────────────────────────────────────

export const scheduleTriggeredSchema = z.object({
  taskId: z.string(),
  taskName: z.string(),
  executionId: z.string(),
  prompt: z.string(),
  firedAt: z.string(),
  triggerType: z.enum(['cron', 'manual']),
});

export const scheduleExecutionCompleteSchema = z.object({
  taskId: z.string(),
  taskName: z.string(),
  executionId: z.string(),
  status: z.enum(['completed', 'failed', 'timeout']),
  durationSec: z.number(),
  error: z.string().nullable(),
  completedAt: z.string(),
  task: scheduledTaskSchema.optional(),
});

// ── Direct-mode payloads ──────────────────────────────────────────────────────

export const directStartSchema = z.object({
  runId: z.string(),
  model: z.string(),
  userMessage: z.string(),
});

export const directCompleteSchema = z.object({
  runId: z.string(),
  model: z.string(),
  durationSec: z.number(),
  modelUsage: z.array(modelUsageSchema),
  totalCostUsd: z.number(),
  error: z.string().optional(),
});

// ── Session snapshot (reconnection payload) ───────────────────────────────────

const inlineDagSchema = z
  .object({
    dagId: z.string().optional(),
    summary: z.string().optional(),
    status: z.string().optional(),
    nodes: z.unknown().optional(),
    completedCount: z.number().optional(),
    totalCount: z.number().optional(),
    elapsed: z.number().optional(),
    isDirect: z.boolean().optional(),
    result: z.unknown().optional(),
    error: z.string().optional(),
    durationSec: z.number().optional(),
    workerCount: z.number().optional(),
    totalCostUsd: z.number().optional(),
    toolCallCount: z.number().optional(),
    modelUsage: z.array(modelUsageSchema).optional(),
    nodeOutputPaths: z.record(z.string(), z.array(z.string())).optional(),
    supersededBy: z.string().optional(),
  })
  .passthrough();

/**
 * Full state snapshot sent to clients on connect/reconnect. Fields the web
 * client reads off the snapshot are typed; unknown extras are tolerated via
 * `.passthrough()`. Every field is optional so any concrete snapshot the
 * gateway builds (persistence snapshot + in-memory overlays) is assignable.
 */
export const sessionSnapshotSchema = z
  .object({
    messages: z.array(historyMessageSchema.passthrough()).optional(),
    memoryEvents: z.array(memoryEventSchema.passthrough()).optional(),
    inlineDAGs: z.record(z.string(), inlineDagSchema).optional(),
    orchestrationEvents: z
      .array(z.object({ event: z.unknown().optional(), workflowId: z.string().optional() }).passthrough())
      .optional(),
    sessionTotals: z
      .object({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        cacheReadTokens: z.number().optional(),
        totalCostUsd: z.number().optional(),
        messageCount: z.number().optional(),
      })
      .passthrough()
      .optional(),
    activePlan: z.unknown().optional(),
    pendingGates: z.record(z.string(), gateRequestSchema.passthrough()).optional(),
    pendingInterventions: z.record(z.string(), interventionRequestSchema.passthrough()).optional(),
    pendingConfirmation: dagConfirmSchema.passthrough().nullable().optional(),
    agentMode: z.string().optional(),
    codingSession: z.unknown().optional(),
    memoryActivity: memoryActivitySchema.optional(),
    clientState: z
      .object({
        agentMode: z.string().optional(),
        lastSeenSeq: z.number().optional(),
        activePanel: z.string().optional(),
      })
      .passthrough()
      .optional(),
    pagination: z.unknown().optional(),
    lastSeq: z.number().optional(),
  })
  .passthrough();

// ── Server → Client envelope ──────────────────────────────────────────────────

/** All server → client message `type` discriminator values. */
export const SERVER_MESSAGE_TYPES = [
  'text',
  'thinking',
  'thinking_step',
  'plan',
  'event',
  'status',
  'command_result',
  'session_status',
  'error',
  'ack',
  'history',
  'dag_dispatched',
  'dag_progress',
  'dag_complete',
  'dag_confirm',
  'gate_request',
  'gate_resolved',
  'intervention_request',
  'intervention_resolved',
  'pong',
  'file_content',
  'memory_activity',
  'memory_event',
  'memory_history',
  'coding_event',
  'direct_started',
  'direct_complete',
  'session',
  'schedule_triggered',
  'schedule_execution_complete',
  'tool_call',
  'tool_result',
  'command_result',
  'presence',
] as const;

export const serverMessageTypeSchema = z.enum(SERVER_MESSAGE_TYPES);

/**
 * Gateway → Client message envelope. All payload fields are optional; the
 * `type` discriminator selects which are populated. `.passthrough()` keeps any
 * field the gateway adds that isn't enumerated here, so the contract never
 * rejects a live message.
 */
export const serverMessageSchema = z
  .object({
    id: z.string(),
    type: serverMessageTypeSchema,
    workflowId: z.string().optional(),
    seq: z.number().optional(),
    replyTo: z.string().optional(),
    content: z.string().optional(),
    streaming: z.boolean().optional(),
    done: z.boolean().optional(),
    thinking: z.string().optional(),
    plan: z.unknown().optional(),
    event: z.unknown().optional(),
    graphState: z.unknown().optional(),
    status: z.unknown().optional(),
    commandResult: commandResultSchema.optional(),
    sessionStatus: sessionStatusSchema.optional(),
    memoryActivity: memoryActivitySchema.optional(),
    memoryEvent: memoryEventSchema.optional(),
    step: stepSchema.optional(),
    error: z.string().optional(),
    path: z.string().optional(),
    history: z.array(historyMessageSchema).optional(),
    memoryEvents: z.array(memoryEventSchema).optional(),
    dagDispatch: dagDispatchSchema.optional(),
    dagProgress: dagProgressSchema.optional(),
    dagComplete: dagCompleteSchema.optional(),
    dagConfirm: dagConfirmSchema.optional(),
    gateRequest: gateRequestSchema.optional(),
    gateResolved: gateResolvedSchema.optional(),
    interventionRequest: interventionRequestSchema.optional(),
    interventionResolved: interventionResolvedSchema.optional(),
    codingEvent: codingEventPayloadSchema.optional(),
    snapshot: sessionSnapshotSchema.optional(),
    sessionId: z.string().optional(),
    bufferedEvents: z.array(z.unknown()).optional(),
    scheduleTriggered: scheduleTriggeredSchema.optional(),
    scheduleExecutionComplete: scheduleExecutionCompleteSchema.optional(),
    directStart: directStartSchema.optional(),
    directComplete: directCompleteSchema.optional(),
    // Fields the web client reads defensively, forwarded from worker/tool events
    // and not enumerated on the gateway `ServerMessage` interface.
    metadata: messageMetadataSchema.optional(),
    toolName: z.string().optional(),
    name: z.string().optional(),
    message: z.string().optional(),
    count: z.number().optional(),
  })
  .passthrough();

// ── Derived types ─────────────────────────────────────────────────────────────

export type ModelUsage = z.infer<typeof modelUsageSchema>;
export type MemoryActivity = z.infer<typeof memoryActivitySchema>;
export type MemoryEvent = z.infer<typeof memoryEventSchema>;
export type SessionStatusPayload = z.infer<typeof sessionStatusSchema>;
export type CommandResultPayload = z.infer<typeof commandResultSchema>;
export type StepPayload = z.infer<typeof stepSchema>;
export type HistoryMessage = z.infer<typeof historyMessageSchema>;
export type ScheduledTaskWire = z.infer<typeof scheduledTaskSchema>;
export type DagDispatchPayload = z.infer<typeof dagDispatchSchema>;
export type DagProgressPayload = z.infer<typeof dagProgressSchema>;
export type DagCompletePayload = z.infer<typeof dagCompleteSchema>;
export type DagConfirmPayload = z.infer<typeof dagConfirmSchema>;
export type GateRequestPayload = z.infer<typeof gateRequestSchema>;
export type GateResolvedPayload = z.infer<typeof gateResolvedSchema>;
export type InterventionRequestPayload = z.infer<typeof interventionRequestSchema>;
export type InterventionResolvedPayload = z.infer<typeof interventionResolvedSchema>;
export type CodingEventPayload = z.infer<typeof codingEventPayloadSchema>;
export type ScheduleTriggeredPayload = z.infer<typeof scheduleTriggeredSchema>;
export type ScheduleExecutionCompletePayload = z.infer<typeof scheduleExecutionCompleteSchema>;
export type DirectStartPayload = z.infer<typeof directStartSchema>;
export type DirectCompletePayload = z.infer<typeof directCompleteSchema>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type ServerMessageType = z.infer<typeof serverMessageTypeSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ── Runtime helpers & type guards ─────────────────────────────────────────────

/** Parse and validate an unknown value as a `ServerMessage` (throws on failure). */
export function parseServerMessage(data: unknown): ServerMessage {
  return serverMessageSchema.parse(data);
}

/** Non-throwing parse — returns a discriminated result. */
export function safeParseServerMessage(
  data: unknown,
): { success: true; data: ServerMessage } | { success: false; error: string } {
  const result = serverMessageSchema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  const issues = result.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { success: false, error: `Invalid server message: ${issues}` };
}

/** Type guard: is the value a structurally valid `ServerMessage`? */
export function isServerMessage(data: unknown): data is ServerMessage {
  return serverMessageSchema.safeParse(data).success;
}

/** Narrow a `ServerMessage` to a specific `type`. */
export function isServerMessageType<T extends ServerMessageType>(
  msg: ServerMessage,
  type: T,
): msg is ServerMessage & { type: T } {
  return msg.type === type;
}

/** Validate an unknown value as a `SessionSnapshot` (throws on failure). */
export function parseSessionSnapshot(data: unknown): SessionSnapshot {
  return sessionSnapshotSchema.parse(data);
}

/** Type guard for the coding-event payload union. */
export function isCodingEventPayload(data: unknown): data is CodingEventPayload {
  return codingEventPayloadSchema.safeParse(data).success;
}
