/**
 * @module components/PlanPrompt
 * Inline plan approval prompt displayed when the gateway sends a plan for review.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { PlannerOutput } from '@orionomega/core';

/** Props for the PlanPrompt component. */
interface PlanPromptProps {
  /** The plan awaiting approval. */
  plan: PlannerOutput;
  /** Callback to respond to the plan. */
  onRespond: (action: 'approve' | 'reject' | 'modify', modification?: string) => void;
}

/**
 * Renders an inline plan approval prompt.
 * Shows plan summary, worker breakdown, and reasoning.
 * Keyboard: [A]pprove, [M]odify, [R]eject.
 */
export function PlanPrompt({ plan, onRespond }: PlanPromptProps): React.ReactElement {
  const [mode, setMode] = useState<'prompt' | 'modify'>('prompt');
  const [modifyText, setModifyText] = useState('');

  const workerCount = plan.graph.nodes.size ?? 0;
  const costStr = plan.estimatedCost < 0.01 ? '<$0.01' : `$${plan.estimatedCost.toFixed(2)}`;
  const timeStr = plan.estimatedTime < 60
    ? `${plan.estimatedTime}s`
    : `${Math.round(plan.estimatedTime / 60)}m`;

  // Truncate reasoning to 3 lines
  const reasoningLines = plan.reasoning.split('\n').slice(0, 3);
  const truncatedReasoning = reasoningLines.join('\n') +
    (plan.reasoning.split('\n').length > 3 ? '\n...' : '');

  // Collect workers from the graph nodes
  const workers: Array<{ label: string; model: string }> = [];
  if (plan.graph.nodes instanceof Map) {
    plan.graph.nodes.forEach(node => {
      if (node.type === 'AGENT' && node.agent) {
        workers.push({ label: node.label, model: node.agent.model });
      }
    });
  } else {
    // Handle serialised record form
    const nodesRecord = plan.graph.nodes as unknown as Record<string, { type: string; label: string; agent?: { model: string } }>;
    for (const node of Object.values(nodesRecord)) {
      if (node.type === 'AGENT' && node.agent) {
        workers.push({ label: node.label, model: node.agent.model });
      }
    }
  }

  useInput((input, key) => {
    if (mode === 'modify') {
      if (key.return) {
        onRespond('modify', modifyText);
        return;
      }
      if (key.escape) {
        setMode('prompt');
        setModifyText('');
        return;
      }
      if (key.backspace || key.delete) {
        setModifyText(prev => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setModifyText(prev => prev + input);
      }
      return;
    }

    // Prompt mode
    const lower = input.toLowerCase();
    if (lower === 'a') onRespond('approve');
    else if (lower === 'r') onRespond('reject');
    else if (lower === 'm') setMode('modify');
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold color="yellow">📋 Plan Review</Text>
      <Text dimColor>{plan.summary}</Text>

      <Box marginTop={1}>
        <Text>Workers: <Text bold>{workerCount}</Text></Text>
        <Text>  Cost: <Text bold>{costStr}</Text></Text>
        <Text>  Time: <Text bold>~{timeStr}</Text></Text>
      </Box>

      {workers.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {workers.map((w, i) => (
            <Text key={i} dimColor>  • {w.label} <Text color="gray">({w.model})</Text></Text>
          ))}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor italic>{truncatedReasoning}</Text>
      </Box>

      {mode === 'prompt' ? (
        <Box marginTop={1}>
          <Text bold color="green">[A]</Text><Text>pprove  </Text>
          <Text bold color="yellow">[M]</Text><Text>odify  </Text>
          <Text bold color="red">[R]</Text><Text>eject</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text>Modification: <Text color="cyan">{modifyText}</Text><Text dimColor>▋</Text></Text>
          <Text dimColor>Enter to submit, Esc to cancel</Text>
        </Box>
      )}
    </Box>
  );
}
