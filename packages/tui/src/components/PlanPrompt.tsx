/**
 * @module components/PlanPrompt
 * Inline plan approval prompt displayed when the gateway sends a plan for review.
 * This is the centrepiece of the user experience — the plan is the product.
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
 * Renders a prominent plan approval prompt.
 * Shows the plan summary, worker breakdown with tasks, reasoning, and cost/time estimates.
 * Keyboard: [A]pprove, [M]odify, [R]eject.
 */
export function PlanPrompt({ plan, onRespond }: PlanPromptProps): React.ReactElement {
  const [mode, setMode] = useState<'prompt' | 'modify'>('prompt');
  const [modifyText, setModifyText] = useState('');

  const costStr = plan.estimatedCost < 0.01 ? '<$0.01' : `$${plan.estimatedCost.toFixed(2)}`;
  const timeStr = plan.estimatedTime < 60
    ? `~${plan.estimatedTime}s`
    : `~${Math.round(plan.estimatedTime / 60)}min`;

  // Collect workers from the graph nodes
  const workers: Array<{ label: string; model: string; task: string; deps: string[] }> = [];
  if (plan.graph.nodes instanceof Map) {
    plan.graph.nodes.forEach(node => {
      if (node.type === 'AGENT' && node.agent) {
        workers.push({
          label: node.label,
          model: node.agent.model,
          task: node.agent.task ?? '',
          deps: node.dependsOn ?? [],
        });
      }
    });
  } else {
    const nodesRecord = plan.graph.nodes as unknown as Record<string, {
      type: string;
      label: string;
      dependsOn?: string[];
      agent?: { model: string; task?: string };
    }>;
    for (const node of Object.values(nodesRecord)) {
      if (node.type === 'AGENT' && node.agent) {
        workers.push({
          label: node.label,
          model: node.agent.model,
          task: node.agent.task ?? '',
          deps: node.dependsOn ?? [],
        });
      }
    }
  }

  // Determine layer info
  const layers = plan.graph.layers ?? [];
  const layerCount = layers.length;

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
    if (lower === 'a' || lower === 'y') onRespond('approve');
    else if (lower === 'r' || lower === 'n') onRespond('reject');
    else if (lower === 'm' || lower === 'e') setMode('modify');
  });

  return (
    <Box flexDirection="column" borderStyle="bold" borderColor="cyan" paddingX={2} paddingY={1} marginY={1}>
      {/* Header */}
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color="cyan">{'═══ '}</Text>
        <Text bold color="white">📋 Execution Plan</Text>
        <Text bold color="cyan">{' ═══'}</Text>
      </Box>

      {/* Summary */}
      <Box marginBottom={1}>
        <Text bold color="white">{plan.summary}</Text>
      </Box>

      {/* Stats bar */}
      <Box marginBottom={1} gap={2}>
        <Box>
          <Text dimColor>Workers: </Text>
          <Text bold color="cyan">{workers.length}</Text>
        </Box>
        {layerCount > 0 && (
          <Box>
            <Text dimColor>Phases: </Text>
            <Text bold color="cyan">{layerCount}</Text>
          </Box>
        )}
        <Box>
          <Text dimColor>Est. Cost: </Text>
          <Text bold color="green">{costStr}</Text>
        </Box>
        <Box>
          <Text dimColor>Est. Time: </Text>
          <Text bold color="yellow">{timeStr}</Text>
        </Box>
      </Box>

      {/* Worker breakdown */}
      {workers.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="white" underline>Workers</Text>
          {workers.map((w, i) => (
            <Box key={i} flexDirection="column" marginTop={1}>
              <Box>
                <Text bold color="cyan">{`  ${i + 1}. `}</Text>
                <Text bold color="white">{w.label}</Text>
                <Text dimColor>{`  (${w.model})`}</Text>
              </Box>
              {w.task && (
                <Box paddingLeft={5}>
                  <Text color="gray">{w.task.length > 120 ? w.task.slice(0, 120) + '…' : w.task}</Text>
                </Box>
              )}
              {w.deps.length > 0 && (
                <Box paddingLeft={5}>
                  <Text dimColor>↳ depends on: {w.deps.join(', ')}</Text>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      )}

      {/* Reasoning */}
      {plan.reasoning && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="white" underline>Reasoning</Text>
          <Box marginTop={1} paddingLeft={2}>
            <Text color="gray">{plan.reasoning}</Text>
          </Box>
        </Box>
      )}

      {/* Divider */}
      <Box marginY={1} justifyContent="center">
        <Text dimColor>{'─'.repeat(50)}</Text>
      </Box>

      {/* Action prompt */}
      {mode === 'prompt' ? (
        <Box justifyContent="center" gap={3}>
          <Box>
            <Text bold color="green" inverse>{' A '}</Text>
            <Text color="green">{' Approve'}</Text>
          </Box>
          <Box>
            <Text bold color="yellow" inverse>{' M '}</Text>
            <Text color="yellow">{' Modify'}</Text>
          </Box>
          <Box>
            <Text bold color="red" inverse>{' R '}</Text>
            <Text color="red">{' Reject'}</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text bold color="yellow">Describe your modification:</Text>
          <Box borderStyle="single" borderColor="yellow" paddingX={1} marginTop={1}>
            <Text color="cyan">{modifyText}</Text>
            <Text dimColor>▋</Text>
          </Box>
          <Text dimColor>Enter to submit · Esc to cancel</Text>
        </Box>
      )}
    </Box>
  );
}
