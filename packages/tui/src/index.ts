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
import chalk from 'chalk';

import { GatewayClient } from './gateway-client.js';
import { ChatLog } from './components/chat-log.js';
import { CustomEditor } from './components/custom-editor.js';
import { formatPlan } from './components/plan-overlay.js';
import { StatusBar } from './components/status-bar.js';
import { WorkflowPanel } from './components/workflow-panel.js';
import { editorTheme, theme, palette, icons, box } from './theme.js';

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
  { name: '/hindsight', description: 'Show Hindsight memory status and troubleshooting' },
  { name: '/exit', description: 'Exit the TUI' },
];

/** Client-side commands that don't go to the gateway. */
const CLIENT_COMMANDS = new Set(['/exit', '/quit', '/q', '/focus', '/hindsight']);

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

  tui.setClearOnShrink(true);

  const RENDER_INTERVAL_MS = 100;
  let renderScheduled = false;
  let lastRenderTime = 0;
  const throttledRender = () => {
    if (renderScheduled) return;
    const now = Date.now();
    const elapsed = now - lastRenderTime;
    if (elapsed >= RENDER_INTERVAL_MS) {
      lastRenderTime = now;
      tui.requestRender();
    } else {
      renderScheduled = true;
      setTimeout(() => {
        renderScheduled = false;
        lastRenderTime = Date.now();
        tui.requestRender();
      }, RENDER_INTERVAL_MS - elapsed);
    }
  };

  const header = new Text('', 1, 0);
  const chatLog = new ChatLog();
  chatLog.onUpdate = () => throttledRender();
  const editor = new CustomEditor(tui, editorTheme);
  const statusBar = new StatusBar();
  const workflowPanel = new WorkflowPanel();
  workflowPanel.onUpdate = () => throttledRender();
  const hindsightBanner = new Text('', 1, 0);

  const root = new Container();
  root.addChild(header);
  root.addChild(hindsightBanner);
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
  statusBar.onUpdate = () => throttledRender();

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

  let wasConnected = false;
  let hindsightConnected: boolean | null = null;
  let userMessageCount = 0;
  let hindsightFirstMessageWarned = false;

  client.on('connected', () => {
    statusBar.connected = true;
    if (wasConnected) {
      chatLog.addMessage({
        id: `reconnect-${Date.now()}`,
        role: 'system',
        content: 'Reconnected to gateway.',
        timestamp: new Date().toISOString(),
      });
    }
    wasConnected = true;
    const saveCheck = setInterval(() => {
      if (client.sessionId) {
        saveSessionId(client.sessionId);
        clearInterval(saveCheck);
      }
    }, 100);
    setTimeout(() => clearInterval(saveCheck), 5000);
    throttledRender();
  });

  client.on('reconnecting', (attempt) => {
    chatLog.addMessage({
      id: `reconnecting-${Date.now()}`,
      role: 'system',
      content: `Gateway unreachable — reconnecting (attempt ${attempt})...`,
      timestamp: new Date().toISOString(),
    });
    throttledRender();
  });

  client.on('history', (messages) => {
    for (const msg of messages) {
      const m = msg as any;
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
    throttledRender();
  });

  client.on('disconnected', () => {
    statusBar.connected = false;
    throttledRender();
  });

  client.on('message', (msg) => {
    chatLog.updateThinking('');
    chatLog.clearStreaming();
    statusBar.thinking = false;

    chatLog.addMessage(msg);

    throttledRender();
  });

  client.on('streaming', (msg) => {
    chatLog.updateThinking('');
    statusBar.thinking = true;
    chatLog.updateStreaming(msg.content);
    throttledRender();
  });

  client.on('streamingDone', () => {
    statusBar.thinking = false;
    chatLog.updateThinking('');
    chatLog.clearStreaming();
    throttledRender();
  });

  client.on('thinking', (text) => {
    if (text) {
      statusBar.thinking = true;
      chatLog.updateThinking(text);
    } else {
      statusBar.thinking = false;
      chatLog.updateThinking('');
    }
    throttledRender();
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

    throttledRender();
  });

  client.on('planCleared', () => {
    throttledRender();
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
          estimatedCost: 0,
        });
      }
    }

    throttledRender();
  });

  client.on('dagComplete', (info) => {
    chatLog.addRunStats({
      status: info.status,
      durationSec: info.durationSec,
      workerCount: info.workerCount,
      totalCostUsd: info.totalCostUsd,
      toolCallCount: info.toolCallCount,
      modelUsage: info.modelUsage,
    });
    throttledRender();
  });

  client.on("sessionStatus", (status) => {
    statusBar.updateStatus({
      model: status.model,
      inputTokens: status.inputTokens,
      outputTokens: status.outputTokens,
      cacheCreationTokens: status.cacheCreationTokens,
      cacheReadTokens: status.cacheReadTokens,
      maxContextTokens: status.maxContextTokens,
      sessionCostUsd: status.sessionCostUsd,
    });
    throttledRender();
  });

  client.on('hindsightStatus', (status) => {
    const wasHsConnected = hindsightConnected;
    hindsightConnected = status.connected;

    statusBar.updateStatus({
      hindsightConnected: status.connected,
      hindsightBusy: status.busy,
    });
    statusBar.hindsightBusy = status.busy;

    if (status.connected) {
      hindsightBanner.setText('');
      if (wasHsConnected === false) {
        chatLog.addSystemSuccess('Hindsight memory reconnected.');
      }
    } else {
      const rule = chalk.hex(palette.warning)(box.horizontal.repeat(68));
      const warnIcon = chalk.hex(palette.warning)(icons.warning);
      const warnText = chalk.hex(palette.warning)(
        "Memory offline \u2014 agent context is limited to recent messages.\n" +
        "   Run 'orionomega setup' to configure Hindsight."
      );
      hindsightBanner.setText(`${rule}\n ${warnIcon}  ${warnText}\n${rule}`);
      if (wasHsConnected === true) {
        chatLog.addSystemWarning('Hindsight memory went offline. Context recall is limited.');
      } else if (wasHsConnected === null) {
        chatLog.addSystemWarning(
          "Hindsight memory is offline. The agent can only recall the last few messages. " +
          "Run 'orionomega setup' to configure it."
        );
        hindsightFirstMessageWarned = true;
      }
    }

    throttledRender();
  });

  client.on('event', (event, workflowId?: string) => {
    const wfId = workflowId ?? event.workflowId;
    if (wfId) {
      workflowPanel.updateNodeEvent(wfId, event);
      throttledRender();
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

      throttledRender();
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
      throttledRender();
      return;
    }

    // /hindsight — show memory system status and troubleshooting
    if (normalizedLower === '/hindsight') {
      const connected = hindsightConnected === true;
      const unknown = hindsightConnected === null;
      const statusIcon = unknown
        ? chalk.hex(palette.warning)(icons.warning)
        : connected
          ? chalk.hex(palette.success)(icons.connected)
          : chalk.hex(palette.error)(icons.disconnected);
      const statusLabel = unknown
        ? chalk.hex(palette.warning)('Unknown (waiting for gateway)')
        : connected
          ? chalk.hex(palette.success)('Connected')
          : chalk.hex(palette.error)('Disconnected');

      let hsUrl = 'http://localhost:8888';
      try {
        const cfg = readConfig();
        if (cfg.hindsight?.url) hsUrl = cfg.hindsight.url;
      } catch {}

      const lines = [
        chalk.hex(palette.accent).bold('Hindsight Memory System'),
        '',
        `  Status:  ${statusIcon} ${statusLabel}`,
        `  URL:     ${chalk.hex(palette.text)(hsUrl)}`,
        '',
      ];

      if (!connected || unknown) {
        lines.push(
          chalk.hex(palette.warning)('  Troubleshooting:'),
          chalk.hex(palette.text)('    1. Run: orionomega setup  (step 4 configures Hindsight)'),
          chalk.hex(palette.text)('    2. Check Docker: docker ps'),
          chalk.hex(palette.text)('    3. macOS: colima status'),
          chalk.hex(palette.text)('    4. Start manually: docker start hindsight'),
          chalk.hex(palette.text)(`    5. Verify: curl ${hsUrl}/health`),
          '',
        );
      }

      chatLog.addMessage({
        id: `hindsight-cmd-${Date.now()}`,
        role: 'system',
        content: '',
        timestamp: new Date().toISOString(),
        raw: lines.join('\n'),
      });
      throttledRender();
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
      userMessageCount++;
      if (userMessageCount === 1 && hindsightConnected === false && !hindsightFirstMessageWarned) {
        hindsightFirstMessageWarned = true;
        chatLog.addSystemWarning(
          'Memory is offline. The agent can only see the last few messages.'
        );
      }
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
