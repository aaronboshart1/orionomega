/**
 * @module components/StatusBar
 * Bottom status bar showing connection state, workflow progress, and time.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { GraphState, WorkerEvent } from '@orionomega/core';

/** Props for the StatusBar component. */
interface StatusBarProps {
  /** Whether the gateway WebSocket is connected. */
  connected: boolean;
  /** Current graph state, or null if no active workflow. */
  graphState: GraphState | null;
  /** Recent worker events. */
  recentEvents: WorkerEvent[];
}

/**
 * Fixed bottom status bar.
 * Left: connection status. Center: workflow progress. Right: current time.
 */
export function StatusBar({ connected, graphState, recentEvents }: StatusBarProps): React.ReactElement {
  const [time, setTime] = useState(formatTime());
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;

  // Update clock every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => setTime(formatTime()), 10_000);
    return () => clearInterval(interval);
  }, []);

  // Connection indicator
  const connStr = connected ? '🟢 Connected' : '🔴 Disconnected';

  // Workflow progress
  let centerStr: string;
  if (graphState && graphState.status === 'running') {
    const doneWorkers = Object.values(graphState.nodes).filter(
      n => n.status === 'done'
    ).length;
    const totalWorkers = Object.keys(graphState.nodes).length;
    centerStr = `🔄 ${graphState.name} | ${graphState.completedLayers}/${graphState.totalLayers} layers | ${doneWorkers}/${totalWorkers} workers`;
  } else if (graphState && graphState.status === 'complete') {
    centerStr = `✅ ${graphState.name} — Complete`;
  } else if (graphState && graphState.status === 'error') {
    centerStr = `❌ ${graphState.name} — Error`;
  } else {
    centerStr = recentEvents.length > 0 ? 'Idle' : 'Ready';
  }

  // Pad center to fill available space
  const sideWidth = Math.max(connStr.length, time.length) + 2;
  const availCenter = Math.max(0, termWidth - sideWidth * 2);
  const paddedCenter = centerStr.length > availCenter
    ? centerStr.slice(0, availCenter - 1) + '…'
    : centerStr;

  return (
    <Box
      borderStyle="single"
      borderColor={connected ? 'green' : 'red'}
      paddingX={1}
      justifyContent="space-between"
    >
      <Text>{connStr}</Text>
      <Text>{paddedCenter}</Text>
      <Text dimColor>{time}</Text>
    </Box>
  );
}

/** Format current time as HH:MM. */
function formatTime(): string {
  const now = new Date();
  return now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
