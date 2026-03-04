#!/usr/bin/env node
/**
 * @module index
 * Entry point for the OrionOmega TUI.
 * Parses CLI arguments and renders the Ink application.
 *
 * Usage:
 *   orionomega-tui [gateway-url] [token]
 *   ORIONOMEGA_TOKEN=xxx orionomega-tui ws://localhost:18790/ws
 */

import React from 'react';
import { render } from 'ink';
import { App } from './components/App.js';

const gatewayUrl = process.argv[2] || 'ws://127.0.0.1:18790/ws';
const token = process.argv[3] || process.env['ORIONOMEGA_TOKEN'] || '';

const { waitUntilExit } = render(<App gatewayUrl={gatewayUrl} token={token} />);
await waitUntilExit();
