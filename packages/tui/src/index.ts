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
    const port = config.gateway.port || 8000;
    return `ws://${host}:${port}/ws`;
  } catch {
    return 'ws://127.0.0.1:8000/ws';
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

  const header = new Text('', 1, 0);
  const chatLog = new ChatLog();
  chatLog.onUpdate = () => tui.requestRender();
  const editor = new CustomEditor(tui, editorTheme);
  const statusBar = new StatusBar();
  const workflowPanel = new WorkflowPanel();
  workflowPanel.onUpdate = () => tui.requestRender();

  const root = new Container();
  root.addChild(header);
  root.addChild(chatLog);
  root.addChild(workflowPanel);
  root.addChild(editor);
  root.addChild(statusBar);

  tui.addChild(root);
  tui.setFocus(editor);

  // Set initial model display
  const model = defaultModel();
  if (model) statusBar.updateStatus({ model });

  // Wire status bar spinner to trigger re-renders
  statusBar.onUpdate = () => tui.requestRender();

  // Autocomplete for slash commands
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd()),
  );

  // ── Gateway connection ────────────────────────────────────────

  const client = new GatewayClient(gatewayUrl, token);
  client.sessionId = loadSessionId();
  const pendingPlans = new Map<string, { plan: PlannerOutput; receivedAt: string }>();

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
    tui.requestRender();
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
    tui.requestRender();
  });

  client.on('disconnected', () => {
    statusBar.connected = false;
    tui.requestRender();
  });

  client.on('message', (msg) => {
    chatLog.updateThinking('');
    chatLog.clearStreaming();
    statusBar.thinking = false;

    // Route workflow-scoped messages to the WorkflowBox instead of chat log
    if (msg.workflowId && workflowPanel.boxes.has(msg.workflowId)) {
      workflowPanel.boxes.get(msg.workflowId)!.addResult(msg.content);
    } else {
      chatLog.addMessage(msg);
    }

    tui.requestRender();
  });

  client.on('streaming', (msg) => {
    chatLog.updateThinking('');
    statusBar.thinking = true;
    chatLog.updateStreaming(msg.content);
    tui.requestRender();
  });

  client.on('streamingDone', () => {
    statusBar.thinking = false;
    chatLog.updateThinking('');
    chatLog.clearStreaming();
    tui.requestRender();
  });

  client.on('thinking', (text) => {
    if (text) {
      statusBar.thinking = true;
      chatLog.updateThinking(text);
    } else {
      statusBar.thinking = false;
      chatLog.updateThinking('');
    }
    tui.requestRender();
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

    tui.requestRender();
  });

  client.on('planCleared', () => {
    // planCleared fires per-plan after respondToPlan; the map is managed in onSubmit
    tui.requestRender();
  });

  client.on('graphState', (state: GraphState, workflowId?: string) => {
    const wfId = workflowId ?? state.workflowId ?? state.name;
    const isNew = !workflowPanel.boxes.has(wfId);

    if (isNew) {
      workflowPanel.addWorkflow(wfId, state);

      // Chat-level notification when a new workflow starts while others are running
      const activeCount = workflowPanel.activeCount;
      if (activeCount > 1) {
        chatLog.addMessage({
          id: `wf-notify-${wfId}`,
          role: 'system',
          content: `New workflow started: "${state.name}" (${activeCount} workflows now active)`,
          timestamp: new Date().toISOString(),
          emoji: '\u26A1',
        });
      }
    } else {
      workflowPanel.updateWorkflow(wfId, state);
    }

    // Aggregate stats across ALL active workflows (not just the one that sent this event)
    const agg = workflowPanel.getAggregateStats();

    statusBar.updateStatus({
      activeTasks: agg.activeWorkflows,
      activeWorkers: agg.totalRunningWorkers,
      completedTasks: agg.totalCompletedNodes,
      totalTasks: agg.totalNodes,
      estimatedCost: agg.combinedCost,
      completedLayers: agg.totalCompletedLayers,
      totalLayers: agg.totalLayers,
      workflowElapsed: agg.maxElapsed,
      workerSummaries: agg.workerSummaries,
    });

    if (state.status === 'complete' || state.status === 'error' || state.status === 'stopped') {
      if (agg.activeWorkflows === 0) {
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

    tui.requestRender();
  });

  client.on("sessionStatus", (status) => {
    statusBar.updateStatus({
      model: status.model,
      inputTokens: status.inputTokens,
      outputTokens: status.outputTokens,
      maxContextTokens: status.maxContextTokens,
    });
    tui.requestRender();
  });

  client.on('hindsightStatus', (status) => {
    statusBar.updateStatus({
      hindsightConnected: status.connected,
      hindsightBusy: status.busy,
    });
    statusBar.hindsightBusy = status.busy;
    tui.requestRender();
  });

  client.on('event', (event, workflowId?: string) => {
    const wfId = workflowId ?? event.workflowId;
    if (wfId) {
      workflowPanel.updateNodeEvent(wfId, event);
      tui.requestRender();
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

      tui.requestRender();
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
      tui.requestRender();
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

  const cleanup = () => {
    try { statusBar.dispose(); } catch {}
    try { client.dispose(); } catch {}
    try { tui.stop(); } catch {}
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

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
