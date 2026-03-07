/**
 * @module components/plan-overlay
 * Plan approval overlay displayed when the planner presents a workflow graph.
 */

import { Container, Text, Spacer, Key, matchesKey } from '@mariozechner/pi-tui';
import type { Component, Focusable } from '@mariozechner/pi-tui';
import type { PlannerOutput } from '@orionomega/core';
import { theme } from '../theme.js';

export class PlanOverlay extends Container implements Focusable {
  focused = false;
  private readonly plan: PlannerOutput;
  onRespond?: (action: 'approve' | 'reject' | 'modify') => void;

  constructor(plan: PlannerOutput) {
    super();
    this.plan = plan;
    this.buildContent();
  }

  private buildContent(): void {
    const p = this.plan;
    const graph = p.graph;

    this.addChild(new Text(theme.accent('━'.repeat(60)), 1, 0));
    this.addChild(new Text(theme.accent(`📋 Execution Plan: ${graph.name}`), 1, 0));
    this.addChild(new Spacer(1));

    // Show nodes — graph.nodes may be a Map (in-process) or plain object (over JSON/WebSocket)
    const nodes = graph.nodes instanceof Map
      ? graph.nodes
      : new Map(Object.entries(graph.nodes as Record<string, typeof graph.nodes extends Map<string, infer V> ? V : never>));

    for (const [, node] of nodes) {
      const n = node as { label?: string; agent?: { model?: string }; dependsOn?: string[] };
      const modelLabel = n.agent?.model ? ` (${n.agent.model})` : '';
      const deps = n.dependsOn ?? [];
      const depsLabel = deps.length > 0 ? ` → after ${deps.join(', ')}` : '';
      this.addChild(new Text(
        `  ${theme.accent('•')} ${theme.assistant(n.label ?? 'unnamed')}${theme.dim(modelLabel)}${theme.dim(depsLabel)}`,
        1, 0,
      ));
    }

    this.addChild(new Spacer(1));

    // Reasoning
    if (p.reasoning) {
      this.addChild(new Text(theme.dim(`Reasoning: ${p.reasoning}`), 1, 0));
      this.addChild(new Spacer(1));
    }

    this.addChild(new Text(
      `${theme.success('[Enter]')} Approve  ${theme.error('[Esc]')} Reject  ${theme.accent('[m]')} Modify`,
      1, 0,
    ));
    this.addChild(new Text(theme.accent('━'.repeat(60)), 1, 0));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      this.onRespond?.('approve');
    } else if (matchesKey(data, Key.escape)) {
      this.onRespond?.('reject');
    } else if (data === 'm' || data === 'M') {
      this.onRespond?.('modify');
    }
  }

  invalidate(): void {
    super.invalidate();
  }
}
