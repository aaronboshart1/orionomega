#!/usr/bin/env node
/**
 * @module index
 * Entry point for the OrionOmega TUI.
 * Built on pi-tui — imperative component tree with differential rendering.
 */

import {
  Container,
  CombinedAutocompleteProvider,
  ProcessTerminal,
  Text,
  TUI,
  type SlashCommand,
} from '@mariozechner/pi-tui';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readConfig } from '@orionomega/core';
import type { PlannerOutput, GraphState } from '@orionomega/core';

import { GatewayClient } from './gateway-client.js';
import { ChatLog } from './components/chat-log.js';
import { CustomEditor } from './components/custom-editor.js';
import { formatPlan } from './components/plan-overlay.js';
import { StatusBar } from './components/status-bar.js';
import { WorkflowPanel } from './components/workflow-panel.js';
import { omegaSpinner } from './components/omega-spinner.js';
import { editorTheme, theme } from './theme.js';

/** Available slash commands. */
const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show available commands' },
  { name: '/workflows', description: 'List all active workflows' },
  { name: '/status', description: 'Session and system status' },
  { name: '/reset', description: 'Clear history and detach workflow' },
  { name: '/stop', description: 'Stop the active workflow' },
  { name: '/restart', description: 'Restart the gateway service' },
  { name: '/plan', description: 'Show the current execution plan' },
  { name: '/workers', description: 'List active workers' },
  { name: '/skills', description: 'View, enable/disable, configure skills' },
  { name: '/focus', description: 'Focus a workflow by ID (or /focus to show all)' },
  { name: '/exit', description: 'Exit the TUI' },
];

/** Client-side commands that don't go to the gateway. */
const CLIENT_COMMANDS = new Set(['/exit', '/quit', '/q', '/focus']);

/**
 * Build the default gateway WebSocket URL from config.
 */
function defaultGatewayUrl(): string {
  try {
    const config = readConfig();
    const host = config.gateway.bind || '127.0.0.1';
    const port = config.gateway.port || 7800;
    return `ws://${host}:${port}/ws`;
  } catch {
    return 'ws://127.0.0.1:7800/ws';
  }
}

/**
 * Derive default model from config for initial status bar display.
 */
function defaultModel(): string {
  try {
    const config = readConfig();
    return config.models.default ?? '';
  } catch {
    return '';
  }
}

const SESSION_FILE = join(homedir(), '.orionomega', '.session');

function loadSessionId(): string | null {
  try {
    return readFileSync(SESSION_FILE, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function saveSessionId(id: string): void {
  try {
    mkdirSync(join(homedir(), '.orionomega'), { recursive: true });
    writeFileSync(SESSION_FILE, id, 'utf-8');
  } catch {}
}

/**
 * Format a queue of pending plans into a human-readable summary.
 */
function formatPlanQueue(plans: Map<string, { plan: PlannerOutput; receivedAt: string }>): string {
  const lines = ['Pending Plans:', ''];
  let i = 1;
  for (const [, { plan }] of plans) {
    const g = plan.graph;
    const nodeCount = g.nodes instanceof Map ? (g.nodes as Map<string, unknown>).size : Object.keys(g.nodes as object).length;
    lines.push(`  ${i}. ${g.name}`);
    const mins = Math.round((plan.estimatedTime ?? 0) / 60);
    const cost = (plan.estimatedCost ?? 0).toFixed(2);
    lines.push(`     ${nodeCount} workers · ~${mins}min · ~$${cost}`);
    i++;
  }
  lines.push('', 'Reply: approve 1, approve all, reject 2, or describe changes');
  return lines.join('\n');
}

/**
 * Launch the TUI.
 */
export async function start(): Promise<void> {
  // Resolve connection params
  const explicitUrl = process.argv.find((a, i) => i >= 2 && a.startsWith('ws'));
  const gatewayUrl = explicitUrl || process.env['ORIONOMEGA_GATEWAY_URL'] || defaultGatewayUrl();
  const token = process.argv.find((a, i) => i >= 2 && !a.startsWith('ws') && a !== 'tui')
    || process.env['ORIONOMEGA_TOKEN'] || '';

  // ── Build component tree ──────────────────────────────────────

  const tui = new TUI(new ProcessTerminal());

  // Throttle/debounce rapid render requests to prevent flickering.
  // Multiple synchronous events in the same tick are coalesced via setImmediate.
  // A minimum interval cap (~16 ms) prevents render storms across consecutive ticks.
  let _renderPending = false;
  let _lastRenderTime = 0;
  const RENDER_MIN_INTERVAL_MS = 16; // ~60 fps cap

  const scheduleRender = () => {
    if (_renderPending) return;
    _renderPending = true;
    const elapsed = Date.now() - _lastRenderTime;
    const delay = Math.max(0, RENDER_MIN_INTERVAL_MS - elapsed);
    const schedule = (fn: () => void) =>
      delay > 0 ? setTimeout(fn, delay) : setImmediate(fn);
    schedule(() => {
      _renderPending = false;
      _lastRenderTime = Date.now();
      try {
        tui.requestRender();
      } catch (err) {
        // A render error must never crash the process — log to stderr only
        process.stderr.write(`[tui] render error: ${(err as Error)?.message ?? String(err)}\n`);
      }
    });
  };

  const header = new Text('', 1, 0);
  const chatLog = new ChatLog();
  chatLog.onUpdate = () => scheduleRender();
  const editor = new CustomEditor(tui, editorTheme);
  const statusBar = new StatusBar();
  const workflowPanel = new WorkflowPanel();
  workflowPanel.onUpdate = () => scheduleRender();

  const root = new Container();
  root.addChild(header);
  root.addChild(chatLog);
  root.addChild(editor);
  root.addChild(statusBar);

  tui.addChild(root);
  tui.setFocus(editor);

  // Set initial model display
  const model = defaultModel();
  if (model) statusBar.updateStatus({ model });

  // Wire status bar spinner to trigger re-renders
  statusBar.onUpdate = () => scheduleRender();

  // Autocomplete for slash commands
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd()),
  );

  // ── Gateway connection ────────────────────────────────────────

  const client = new GatewayClient(gatewayUrl, token);
  client.sessionId = loadSessionId();
  const pendingPlans = new Map<string, { plan: PlannerOutput; receivedAt: string }>();
  let trackerAttached = false;

  const updateHeader = () => {
    header.setText(theme.header(`  orionomega — ${gatewayUrl}`));
  };

  client.on('connected', () => {
    statusBar.connected = true;
    // Session ID is set from the ack message — save it once available
    const saveCheck = setInterval(() => {
      if (client.sessionId) {
        saveSessionId(client.sessionId);
        clearInterval(saveCheck);
      }
    }, 100);
    // Clear after 5s in case ack never arrives
    setTimeout(() => clearInterval(saveCheck), 5000);
    scheduleRender();
  });

  client.on('history', (messages) => {
    for (const msg of messages) {
      const m = msg as any;
      // Restore plan messages as formatted plans
      if (m.type === 'plan' && m.content) {
        try {
          const plan = JSON.parse(m.content);
          const formatted = formatPlan(plan);
          chatLog.addMessage({
            id: msg.id,
            role: 'system',
            content: '',
            timestamp: msg.timestamp,
            raw: formatted,
          });
          // Restore pending plan state
          pendingPlans.set(msg.id, { plan, receivedAt: msg.timestamp });
          continue;
        } catch {}
      }
      chatLog.addMessage({
        id: msg.id,
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
        timestamp: msg.timestamp,
      });
    }
    scheduleRender();
  });

  client.on('disconnected', () => {
    statusBar.connected = false;
    scheduleRender();
  });

  client.on('message', (msg) => {
    chatLog.updateThinking('');
    chatLog.clearStreaming();
    statusBar.thinking = false;
    chatLog.addMessage(msg);
    scheduleRender();
  });

  client.on('streaming', (msg) => {
    chatLog.updateThinking('');
    statusBar.thinking = true;
    chatLog.updateStreaming(msg.content);
    scheduleRender();
  });

  client.on('streamingDone', () => {
    statusBar.thinking = false;
    chatLog.updateThinking('');
    chatLog.clearStreaming();
    scheduleRender();
  });

  client.on('thinking', (text) => {
    if (text) {
      statusBar.thinking = true;
      chatLog.updateThinking(text);
    } else {
      statusBar.thinking = false;
      chatLog.updateThinking('');
    }
    scheduleRender();
  });

  client.on('plan', (plan: PlannerOutput, planId: string) => {
    pendingPlans.set(planId, { plan, receivedAt: new Date().toISOString() });
    statusBar.thinking = false;

    if (pendingPlans.size === 1) {
      // Single plan — show inline as usual
      const formatted = formatPlan(plan);
      chatLog.addMessage({
        id: `plan-${planId}`,
        role: 'system',
        content: '',
        timestamp: new Date().toISOString(),
        raw: formatted,
      });
    } else {
      // Multiple plans — show queue summary
      const summary = formatPlanQueue(pendingPlans);
      chatLog.addMessage({
        id: 'plan-queue',
        role: 'system',
        content: '',
        timestamp: new Date().toISOString(),
        raw: summary,
      });
    }

    scheduleRender();
  });

  client.on('planCleared', () => {
    // planCleared fires per-plan after respondToPlan; the map is managed in onSubmit
    scheduleRender();
  });

  client.on('graphState', (state: GraphState, workflowId?: string) => {
    const wfId = workflowId ?? state.workflowId ?? state.name;

    // Attach multi-tracker to chat log once
    if (!trackerAttached) {
      chatLog.addChild(workflowPanel);
      trackerAttached = true;
    }

    if (!workflowPanel.boxes.has(wfId)) {
      workflowPanel.addWorkflow(wfId, state);
    } else {
      workflowPanel.updateWorkflow(wfId, state);
    }

    // Aggregate stats across all workflows
    const nodes = state.nodes ?? {};
    const nodeList = Object.values(nodes) as any[];
    const runningNodes = nodeList.filter((n: any) => n.status === 'running' || n.status === 'in_progress');
    const complete = nodeList.filter((n: any) => n.status === 'complete' || n.status === 'done').length;
    const total = nodeList.length;

    // Extract short labels for each active worker
    const workerSummaries = runningNodes.map((n: any) => n.label ?? n.id);

    statusBar.updateStatus({
      activeTasks: workflowPanel.activeCount,
      activeWorkers: runningNodes.length,
      completedTasks: complete,
      totalTasks: total,
      estimatedCost: state.estimatedCost,
      completedLayers: state.completedLayers,
      totalLayers: state.totalLayers,
      workflowElapsed: state.elapsed,
      workerSummaries,
    });

    if (state.status === 'complete' || state.status === 'error' || state.status === 'stopped') {
      if (workflowPanel.activeCount === 0) {
        statusBar.updateStatus({
          activeTasks: 0,
          activeWorkers: 0,
          completedLayers: 0,
          totalLayers: 0,
          workflowElapsed: 0,
          workerSummaries: [],
        });
      }
    }

    scheduleRender();
  });

  client.on("sessionStatus", (status) => {
    statusBar.updateStatus({
      model: status.model,
      inputTokens: status.inputTokens,
      outputTokens: status.outputTokens,
      maxContextTokens: status.maxContextTokens,
    });
    scheduleRender();
  });

  client.on('hindsightStatus', (status) => {
    statusBar.updateStatus({
      hindsightConnected: status.connected,
      hindsightBusy: status.busy,
    });
    statusBar.hindsightBusy = status.busy;
    scheduleRender();
  });

  client.on('event', (event, workflowId?: string) => {
    const wfId = workflowId ?? event.workflowId;
    if (wfId) {
      workflowPanel.updateNodeEvent(wfId, event);
      scheduleRender();
    }
  });

  // ── Handle session_status from gateway ────────────────────────

  // Extend to handle session_status messages if gateway sends them
  // For now, we derive what we can from events and config

  // ── Editor submission ─────────────────────────────────────────

  editor.onSubmit = (text: string) => {
    const value = text.trim();
    if (!value) return;

    // If any plans are pending, handle plan approval/rejection
    if (pendingPlans.size > 0) {
      editor.setText('');
      editor.addToHistory(value);

      const lower = value.toLowerCase().trim();

      if (/^approve all$/i.test(lower)) {
        for (const [pid] of pendingPlans) client.respondToPlan(pid, 'approve');
        pendingPlans.clear();
        statusBar.thinking = true;
      } else if (/^approve (\d+)$/.test(lower)) {
        const idx = parseInt(lower.match(/\d+/)![0], 10) - 1;
        const ids = [...pendingPlans.keys()];
        if (idx >= 0 && idx < ids.length) {
          client.respondToPlan(ids[idx], 'approve');
          pendingPlans.delete(ids[idx]);
          statusBar.thinking = true;
        }
      } else if (/^reject (\d+)$/.test(lower)) {
        const idx = parseInt(lower.match(/\d+/)![0], 10) - 1;
        const ids = [...pendingPlans.keys()];
        if (idx >= 0 && idx < ids.length) {
          client.respondToPlan(ids[idx], 'reject');
          pendingPlans.delete(ids[idx]);
        }
      } else if (pendingPlans.size === 1) {
        // Single plan — conversational plan response
        const isApproval = /^(y|yes|go|do it|go ahead|ok|okay|approve|run it|execute|looks good|lgtm|ship it|send it|this is correct|correct|perfect|that works|sounds good|exactly)$/i.test(lower);
        const isRejection = /^(n|no|nah|nope|reject|cancel|scrap it|start over|nevermind|never mind)$/i.test(lower);
        const [planId] = pendingPlans.keys();
        if (isApproval) {
          client.respondToPlan(planId, 'approve');
          statusBar.thinking = true;
        } else if (isRejection) {
          client.respondToPlan(planId, 'reject');
          statusBar.thinking = true;
        } else {
          // Anything else = approve with modifications
          // The user is adding context, refining, or giving the go-ahead with extra instructions
          client.respondToPlan(planId, 'modify', value);
          statusBar.thinking = true;
        }
        pendingPlans.delete(planId);
      } else {
        // Multiple plans pending + ambiguous input — send as chat
        client.sendChat(value);
        statusBar.thinking = true;
      }

      scheduleRender();
      return;
    }

    editor.setText('');
    editor.addToHistory(value);

    // Normalize: strip leading extra slashes and any stray whitespace
    const normalized = value.replace(/^\/+/, '/').trim();

    const normalizedLower = normalized.toLowerCase();
    if (normalizedLower === '/exit' || normalizedLower === '/quit' || normalizedLower === '/q') {
      cleanup();
      return;
    }

    // /focus [workflowId] — client-side focus command
    if (normalizedLower.startsWith('/focus')) {
      const arg = normalized.slice('/focus'.length).trim() || null;
      workflowPanel.setFocus(arg);
      scheduleRender();
      return;
    }

    // Also check without slash — some paths strip it
    const bareCmd = normalized.replace(/^\//, '').toLowerCase();
    if (bareCmd === 'exit' || bareCmd === 'quit' || bareCmd === 'q') {
      cleanup();
      return;
    }

    statusBar.thinking = true;

    if (normalized.startsWith('/')) {
      client.sendCommand(normalized.slice(1));
    } else {
      client.sendChat(value);
    }
  };

  editor.onCtrlC = () => cleanup();
  editor.onCtrlD = () => cleanup();

  // ── Lifecycle ─────────────────────────────────────────────────

  // One-shot cleanup guard — ensures terminal state is restored exactly once
  // regardless of how many signals or errors fire concurrently.
  let _cleanupDone = false;
  const cleanup = () => {
    if (_cleanupDone) return;
    _cleanupDone = true;
    try { statusBar.dispose(); } catch {}
    try { workflowPanel.dispose(); } catch {}
    try { omegaSpinner.dispose(); } catch {}
    try { client.dispose(); } catch {}
    try { tui.stop(); } catch {}
    process.exit(0);
  };

  // Terminal state must be restored on all exit paths — SIGINT, SIGTERM,
  // and unexpected crashes.  All handlers are registered as one-shot via the
  // _cleanupDone flag so they cannot double-fire.
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  process.on('uncaughtException', (err) => {
    process.stderr.write(`[tui] uncaught exception: ${err?.message ?? String(err)}\n`);
    cleanup();
  });

  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[tui] unhandled rejection: ${String(reason)}\n`);
    cleanup();
  });

  // Re-render on terminal resize with bounds checking already inside getBoxWidth()
  process.stdout.on('resize', () => {
    scheduleRender();
  });

  updateHeader();
  tui.start();

  await client.connect();

  // Keep the process alive
  await new Promise<void>(() => {});
}

// Direct execution
const isCLIDirect = process.argv[1]?.includes('orionomega-tui') ||
                    process.argv[1]?.endsWith('/tui/dist/index.js');

if (isCLIDirect) {
  start().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
