#!/usr/bin/env node
/**
 * @module index
 * Entry point for the OrionOmega TUI.
 *
 * When run directly (orionomega-tui), it launches immediately.
 * When imported by @orionomega/core, call start() to launch.
 *
 * Usage:
 *   orionomega tui [gateway-url] [token]
 *   ORIONOMEGA_TOKEN=xxx orionomega tui ws://localhost:7800/ws
 */

import React from 'react';
import { render } from 'ink';
import { App } from './components/App.js';
import { readConfig } from '@orionomega/core';

/**
 * Build the default gateway WebSocket URL from the config file.
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
 * Launch the TUI. Called by the CLI via "orionomega tui".
 */
export async function start(): Promise<void> {
  // Ensure mouse tracking is disabled on any exit
  const disableMouse = () => {
    process.stdout.write('[?1006l');
    process.stdout.write('[?1000l');
  };
  process.on('exit', disableMouse);
  process.on('SIGINT', () => { disableMouse(); process.exit(0); });
  process.on('SIGTERM', () => { disableMouse(); process.exit(0); });
  // argv[3] when invoked as "orionomega tui [url] [token]"
  // argv[2] when invoked directly as "orionomega-tui [url] [token]"
  const explicitUrl = process.argv.find((a, i) => i >= 2 && a.startsWith('ws'));
  const gatewayUrl = explicitUrl || process.env['ORIONOMEGA_GATEWAY_URL'] || defaultGatewayUrl();
  const token = process.argv.find((a, i) => i >= 2 && !a.startsWith('ws') && a !== 'tui') 
    || process.env['ORIONOMEGA_TOKEN'] || '';

  const { waitUntilExit } = render(<App gatewayUrl={gatewayUrl} token={token} />);
  await waitUntilExit();
}

// Direct execution (orionomega-tui binary)
const isCLIDirect = process.argv[1]?.includes('orionomega-tui') ||
                    process.argv[1]?.endsWith('/tui/dist/index.js');

if (isCLIDirect) {
  start().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
