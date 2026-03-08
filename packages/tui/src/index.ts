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
import { readConfig } from '@orionomega/core';
import type { PlannerOutput, GraphState } from '@orionomega/core';

import { GatewayClient } from './gateway-client.js';
import { ChatLog } from './components/chat-log.js';
import { CustomEditor } from './components/custom-editor.js';
import { formatPlan } from './components/plan-overlay.js';
import { StatusBar } from './components/status-bar.js';
import { WorkflowTracker } from './components/workflow-tracker.js';
import { editorTheme, theme } from './theme.js';

/** Available slash commands. */
const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show available commands' },
  { name: '/status', description: 'Session and system status' },
  { name: '/reset', description: 'Clear history and detach workflow' },
  { name: '/stop', description: 'Stop the active workflow' },
  { name: '/restart', description: 'Restart the gateway service' },
  { name: '/plan', description: 'Show the current execution plan' },
  { name: '/workers', description: 'List active workers' },
  { name: '/skills', description: 'View, enable/disable, configure skills' },
  { name: '/exit', description: 'Exit the TUI' },
];

/** Client-side commands that don't go to the gateway. */
const CLIENT_COMMANDS = new Set(['/exit', '/quit', '/q']);

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
  const editor = new CustomEditor(tui, editorTheme);
  const statusBar = new StatusBar();
  const workflowTracker = new WorkflowTracker();

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
  statusBar.onUpdate = () => tui.requestRender();

  // Autocomplete for slash commands
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd()),
  );

  // ── Gateway connection ────────────────────────────────────────

  const client = new GatewayClient(gatewayUrl, token);
  let activePlanId: string | null = null;
  let workflowActive = false;

  const updateHeader = () => {
    header.setText(theme.header(`  orionomega — ${gatewayUrl}`));
  };

  client.on('connected', () => {
    statusBar.connected = true;
    chatLog.addMessage({
      id: 'sys-connected',
      role: 'system',
      content: 'Connected to gateway',
      timestamp: new Date().toISOString(),
      emoji: '🟢',
    });
    tui.requestRender();
  });

  client.on('disconnected', () => {
    statusBar.connected = false;
    tui.requestRender();
  });

  client.on('message', (msg) => {
    chatLog.clearStreaming();
    statusBar.thinking = false;
    chatLog.addMessage(msg);
    tui.requestRender();
  });

  client.on('streaming', (msg) => {
    statusBar.thinking = true;
    chatLog.updateStreaming(msg.content);
    tui.requestRender();
  });

  client.on('streamingDone', () => {
    statusBar.thinking = false;
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
    activePlanId = planId;
    statusBar.thinking = false;

    // Render plan inline in chat
    const formatted = formatPlan(plan);
    chatLog.addMessage({
      id: `plan-${planId}`,
      role: 'system',
      content: '',
      timestamp: new Date().toISOString(),
      raw: formatted,
    });

    tui.requestRender();
  });

  client.on('planCleared', () => {
    activePlanId = null;
    tui.requestRender();
  });

  client.on('graphState', (state: GraphState) => {
    // Track workflow in status bar
    const nodes = state.nodes ?? {};
    const nodeList = Object.values(nodes) as any[];
    const running = nodeList.filter((n: any) => n.status === 'running' || n.status === 'in_progress').length;
    const complete = nodeList.filter((n: any) => n.status === 'complete' || n.status === 'done').length;
    const total = nodeList.length;

    statusBar.updateStatus({
      activeTasks: running > 0 ? 1 : 0,
      activeWorkers: running,
      completedTasks: complete,
      totalTasks: total,
      estimatedCost: state.estimatedCost,
    });

    // Initialize or update workflow tracker
    if (!workflowActive) {
      workflowActive = true;
      workflowTracker.initFromGraphState(state);
      chatLog.addChild(workflowTracker);
    } else {
      workflowTracker.updateFromGraphState(state);
    }

    // Check if workflow completed
    if (state.status === 'complete' || state.status === 'error' || state.status === 'stopped') {
      workflowActive = false;
      statusBar.updateStatus({
        activeTasks: 0,
        activeWorkers: 0,
      });
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

  client.on('event', (event) => {
    // Update workflow tracker with individual events
    if (workflowActive) {
      workflowTracker.updateNodeEvent(event.nodeId, event.type, event.message);
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

    // If a plan is pending, send the user's response as plan feedback
    if (activePlanId) {
      editor.setText('');
      editor.addToHistory(value);

      // Interpret natural language: affirmative → approve, otherwise send as modification
      const lower = value.toLowerCase();
      const isApproval = /^(y|yes|go|do it|go ahead|ok|okay|approve|run it|execute|looks good|lgtm|ship it|send it)$/i.test(lower);

      if (isApproval) {
        client.respondToPlan(activePlanId, 'approve');
        statusBar.thinking = true;
      } else {
        client.respondToPlan(activePlanId, 'reject');
        // Send the feedback as a new chat message so the agent can re-plan
        client.sendChat(value);
        statusBar.thinking = true;
      }
      activePlanId = null;
      tui.requestRender();
      return;
    }

    editor.setText('');
    editor.addToHistory(value);

    // Normalize: strip leading extra slashes and any stray whitespace
    const normalized = value.replace(/^\/+/, '/').trim();

    if (CLIENT_COMMANDS.has(normalized.toLowerCase())) {
      cleanup();
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
