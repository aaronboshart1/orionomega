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
  type OverlayHandle,
  type SlashCommand,
} from '@mariozechner/pi-tui';
import { readConfig } from '@orionomega/core';
import type { PlannerOutput } from '@orionomega/core';

import { GatewayClient } from './gateway-client.js';
import { ChatLog } from './components/chat-log.js';
import { CustomEditor } from './components/custom-editor.js';
import { PlanOverlay } from './components/plan-overlay.js';
import { editorTheme, theme } from './theme.js';

/** Available slash commands. */
const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show available commands' },
  { name: '/status', description: 'Session and system status' },
  { name: '/reset', description: 'Clear history and detach workflow' },
  { name: '/stop', description: 'Stop the active workflow' },
  { name: '/restart', description: 'Restart the active workflow' },
  { name: '/plan', description: 'Show the current execution plan' },
  { name: '/workers', description: 'List active workers' },
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
  const footer = new Text('', 1, 0);
  const editor = new CustomEditor(tui, editorTheme);

  const root = new Container();
  root.addChild(header);
  root.addChild(chatLog);
  root.addChild(footer);
  root.addChild(editor);

  tui.addChild(root);
  tui.setFocus(editor);

  // Autocomplete for slash commands
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd()),
  );

  // ── Gateway connection ────────────────────────────────────────

  const client = new GatewayClient(gatewayUrl, token);
  let planOverlayHandle: OverlayHandle | null = null;
  let activePlanId: string | null = null;

  const updateHeader = () => {
    header.setText(theme.header(`orionomega tui — ${gatewayUrl}`));
  };

  const updateFooter = () => {
    const status = client.connected
      ? theme.statusConnected() + ' Connected'
      : theme.statusDisconnected() + ' Disconnected';
    const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    footer.setText(`  ${status}${' '.repeat(40)}${theme.dim(time)}`);
    tui.requestRender();
  };

  // Periodic footer update (clock)
  const footerTimer = setInterval(updateFooter, 30_000);

  client.on('connected', () => {
    updateFooter();
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
    updateFooter();
    tui.requestRender();
  });

  client.on('message', (msg) => {
    chatLog.clearStreaming();
    chatLog.addMessage(msg);
    tui.requestRender();
  });

  client.on('streaming', (msg) => {
    chatLog.updateStreaming(msg.content);
    tui.requestRender();
  });

  client.on('streamingDone', () => {
    chatLog.clearStreaming();
    tui.requestRender();
  });

  client.on('thinking', (text) => {
    chatLog.updateThinking(text);
    tui.requestRender();
  });

  client.on('plan', (plan: PlannerOutput, planId: string) => {
    activePlanId = planId;

    // Show plan as an overlay
    const overlay = new PlanOverlay(plan);
    overlay.onRespond = (action) => {
      if (activePlanId) {
        client.respondToPlan(activePlanId, action);
        activePlanId = null;
      }
      if (planOverlayHandle) {
        planOverlayHandle.hide();
        planOverlayHandle = null;
      }
      tui.setFocus(editor);
      tui.requestRender();
    };

    planOverlayHandle = tui.showOverlay(overlay, {
      width: '80%',
      maxHeight: '60%',
      anchor: 'center',
    });
    tui.setFocus(overlay);
    tui.requestRender();
  });

  client.on('planCleared', () => {
    if (planOverlayHandle) {
      planOverlayHandle.hide();
      planOverlayHandle = null;
    }
    tui.setFocus(editor);
    tui.requestRender();
  });

  // ── Editor submission ─────────────────────────────────────────

  editor.onSubmit = (text: string) => {
    const value = text.trim();
    if (!value) return;

    editor.setText('');
    editor.addToHistory(value);

    // Normalize: strip leading extra slashes (e.g. //exit → /exit)
    const normalized = value.replace(/^\/+/, '/');

    if (CLIENT_COMMANDS.has(normalized.toLowerCase())) {
      cleanup();
      return;
    }

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
    clearInterval(footerTimer);
    client.dispose();
    tui.stop();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  updateHeader();
  updateFooter();
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
