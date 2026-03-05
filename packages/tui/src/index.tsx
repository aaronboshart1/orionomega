#!/usr/bin/env node
/**
 * @module index
 * Entry point for the OrionOmega TUI.
 *
 * When run directly (orionomega-tui), it launches immediately.
 * When imported by @orionomega/core, call start() to launch.
 *
 * Usage:
 *   orionomega-tui [gateway-url] [token]
 *   ORIONOMEGA_TOKEN=xxx orionomega-tui ws://localhost:18790/ws
 */

import React from 'react';
import { render } from 'ink';
import { App } from './components/App.js';

/**
 * Launch the TUI. Called by the CLI when no subcommand is given.
 */
export async function start(): Promise<void> {
  const gatewayUrl = process.argv[2] || 'ws://127.0.0.1:18790/ws';
  const token = process.argv[3] || process.env['ORIONOMEGA_TOKEN'] || '';

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
