'use client';

import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  type Node,
  type Edge,
  type ReactFlowInstance,
  useNodesState,
  useEdgesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Maximize2, FoldVertical, UnfoldVertical } from 'lucide-react';

import { useOrchestrationStore, type GraphNode, type InlineDAGNode, type WorkerEvent } from '@/stores/orchestration';
import { WorkerNode } from './WorkerNode';
import { GroupSummaryNode, GroupContainerNode } from './GroupNodes';
import {
  buildDagLayout,
  findCompletedBranchRoots,
  type DagGroup,
  type LayoutGraphNode,
  type PositionedNode,
} from '@/lib/dag-layout';

const nodeTypes = {
  worker: WorkerNode,
  groupSummary: GroupSummaryNode,
  groupContainer: GroupContainerNode,
};

interface NodeMeta {
  status: string;
  progress?: number;
  model?: string;
}

/** Per-tick live data the layout deliberately doesn't carry. */
interface OverlayCtx {
  meta: Map<string, NodeMeta>;
  summaryMembers: Map<string, string[]>;
  onToggleCollapse: (id: string) => void;
  onToggleGroup: (groupId: string) => void;
}

function aggregateStatus(memberIds: string[], meta: Map<string, NodeMeta>) {
  let done = 0;
  let running = 0;
  let error = 0;
  for (const m of memberIds) {
    const s = meta.get(m)?.status;
    if (s === 'done') done++;
    else if (s === 'running') running++;
    else if (s === 'error') error++;
  }
  const status: 'pending' | 'running' | 'done' | 'error' =
    error > 0 ? 'error' : running > 0 ? 'running' : done === memberIds.length && memberIds.length > 0 ? 'done' : 'pending';
  return { done, running, error, status };
}

function statusForNode(id: string, ctx: OverlayCtx): string {
  const direct = ctx.meta.get(id);
  if (direct) return direct.status;
  const members = ctx.summaryMembers.get(id);
  if (members) return aggregateStatus(members, ctx.meta).status;
  return 'pending';
}

function dataForNode(ln: PositionedNode, ctx: OverlayCtx): Record<string, unknown> {
  if (ln.kind === 'groupSummary') {
    const members = ln.memberIds ?? [];
    const agg = aggregateStatus(members, ctx.meta);
    return {
      title: ln.label,
      groupId: ln.groupId,
      memberCount: members.length,
      doneCount: agg.done,
      runningCount: agg.running,
      errorCount: agg.error,
      status: agg.status,
      onToggleGroup: ctx.onToggleGroup,
    };
  }
  if (ln.kind === 'groupContainer') {
    return {
      title: ln.label,
      groupId: ln.groupId,
      memberCount: ln.memberIds?.length ?? 0,
      onToggleGroup: ctx.onToggleGroup,
    };
  }
  const m = ctx.meta.get(ln.id);
  return {
    label: ln.label,
    nodeType: ln.nodeType,
    status: m?.status ?? 'pending',
    progress: m?.progress,
    model: m?.model,
    collapsible: ln.collapsible,
    collapsed: ln.collapsed,
    hiddenCount: ln.hiddenCount,
    onToggleCollapse: ctx.onToggleCollapse,
  };
}

function buildRfNode(ln: PositionedNode, ctx: OverlayCtx): Node {
  const base: Node = {
    id: ln.id,
    type: ln.kind,
    position: { x: ln.x, y: ln.y },
    data: dataForNode(ln, ctx),
  };
  if (ln.kind === 'groupContainer') {
    base.draggable = false;
    base.selectable = false;
    base.zIndex = -1;
    base.width = ln.width;
    base.height = ln.height;
    base.style = { width: ln.width, height: ln.height };
  }
  return base;
}

function edgeStyle(sourceStatus: string) {
  return {
    animated: sourceStatus === 'running',
    style: {
      stroke:
        sourceStatus === 'done'
          ? '#22c55e'
          : sourceStatus === 'running'
            ? '#3b82f6'
            : sourceStatus === 'error'
              ? '#ef4444'
              : '#3f3f46',
    },
  };
}

function inlineNodesToGraphNodes(nodes: InlineDAGNode[]): Record<string, GraphNode> {
  const result: Record<string, GraphNode> = {};
  for (const n of nodes) {
    result[n.id] = {
      id: n.id,
      type: n.type || 'agent',
      label: n.label || n.id,
      status: n.status,
      progress: n.progress,
      dependsOn: n.dependsOn ?? [],
      output: n.output,
    };
  }
  return result;
}

const miniMapColors: Record<string, string> = {
  running: '#3b82f6',
  done: '#22c55e',
  error: '#ef4444',
  skipped: '#52525b',
};

export function DAGVisualization() {
  const graphState = useOrchestrationStore((s) => s.graphState);
  const activeWorkflowId = useOrchestrationStore((s) => s.activeWorkflowId);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const events = useOrchestrationStore((s) => s.events);
  const selectWorker = useOrchestrationStore((s) => s.selectWorker);
  const selectedWorker = useOrchestrationStore((s) => s.selectedWorker);
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [collapsedSubtrees, setCollapsedSubtrees] = useState<Set<string>>(new Set());

  // Raw graph nodes (recomputed per tick — cheap, no layout work here).
  const graphNodes = useMemo<Record<string, GraphNode>>(() => {
    if (graphState) return graphState.nodes;
    const activeDag = activeWorkflowId ? inlineDAGs[activeWorkflowId] : null;
    if (!activeDag || activeDag.nodes.length === 0) return {};
    return inlineNodesToGraphNodes(activeDag.nodes);
  }, [graphState, activeWorkflowId, inlineDAGs]);

  // Live per-node status/progress/model — overlaid onto stable positions.
  const meta = useMemo(() => {
    const m = new Map<string, NodeMeta>();
    for (const n of Object.values(graphNodes)) {
      m.set(n.id, { status: n.status, progress: n.progress, model: n.agent?.model });
    }
    return m;
  }, [graphNodes]);

  // Macro phase → sub-DAG groups, derived client-side from expansion events.
  const groups = useMemo<DagGroup[]>(() => {
    const byId = new Map<string, DagGroup>();
    for (const e of events as WorkerEvent[]) {
      if (e.type !== 'macro_expansion_complete') continue;
      const mc = e.macro;
      if (!mc || !mc.subNodeIds || mc.subNodeIds.length === 0) continue;
      byId.set(mc.macroNodeId, {
        id: mc.macroNodeId,
        title: mc.phaseTitle || mc.phaseId || 'Phase',
        memberIds: mc.subNodeIds,
      });
    }
    return Array.from(byId.values());
  }, [events]);

  /**
   * Structural-only node list (id/type/label/deps). Memoized on a structural
   * signature so its identity stays stable while status ticks, which in turn
   * keeps the layout memo from re-running the topological sort every event.
   */
  const structuralSignature = useMemo(() => {
    const parts: string[] = [];
    for (const n of Object.values(graphNodes)) {
      parts.push(`${n.id}:${n.type}:${[...n.dependsOn].sort().join(',')}`);
    }
    parts.sort();
    return `${activeWorkflowId ?? ''}::${parts.join('|')}`;
  }, [graphNodes, activeWorkflowId]);

  const structuralNodes = useMemo<LayoutGraphNode[]>(() => {
    return Object.values(graphNodes).map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label,
      dependsOn: n.dependsOn ?? [],
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structuralSignature]);

  const groupSignature = useMemo(
    () => groups.map((g) => `${g.id}:${g.memberIds.join(',')}`).sort().join('|'),
    [groups],
  );
  const collapsedGroupsKey = useMemo(() => [...collapsedGroups].sort().join('|'), [collapsedGroups]);
  const collapsedSubtreesKey = useMemo(() => [...collapsedSubtrees].sort().join('|'), [collapsedSubtrees]);

  // The expensive part — runs only on structural / group / collapse changes.
  const layout = useMemo(
    () => buildDagLayout(structuralNodes, { groups, collapsedGroups, collapsedSubtrees }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structuralSignature, groupSignature, collapsedGroupsKey, collapsedSubtreesKey],
  );

  const summaryMembers = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const n of layout.nodes) {
      if (n.kind === 'groupSummary') m.set(n.id, n.memberIds ?? []);
    }
    return m;
  }, [layout]);

  const onToggleCollapse = useCallback((id: string) => {
    setCollapsedSubtrees((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onToggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const ctx = useMemo<OverlayCtx>(
    () => ({ meta, summaryMembers, onToggleCollapse, onToggleGroup }),
    [meta, summaryMembers, onToggleCollapse, onToggleGroup],
  );
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const layoutNodeById = useMemo(() => {
    const m = new Map<string, PositionedNode>();
    for (const n of layout.nodes) m.set(n.id, n);
    return m;
  }, [layout]);

  const prevSignatureRef = useRef<string>('');
  const pendingFitRef = useRef(false);

  /**
   * Structural change (new/removed nodes, collapse toggled, workflow switch):
   * rebuild the React Flow arrays wholesale and schedule a viewport re-fit.
   */
  useEffect(() => {
    if (prevSignatureRef.current === layout.signature) return;
    const isFirst = prevSignatureRef.current === '';
    prevSignatureRef.current = layout.signature;
    const c = ctxRef.current;
    setNodes(layout.nodes.map((ln) => buildRfNode(ln, c)));
    setEdges(
      layout.edges.map((e) => {
        const st = edgeStyle(statusForNode(e.source, c));
        return { id: e.id, source: e.source, target: e.target, animated: st.animated, style: st.style };
      }),
    );
    if (!isFirst) pendingFitRef.current = true;
  }, [layout, setNodes, setEdges]);

  /**
   * Data-only tick (status / progress / model / edge colour): patch existing
   * nodes & edges by id so React Flow keeps its measurements and never tears.
   */
  useEffect(() => {
    setNodes((curr) =>
      curr.map((n) => {
        const ln = layoutNodeById.get(n.id);
        return ln ? { ...n, data: dataForNode(ln, ctx) } : n;
      }),
    );
    setEdges((curr) =>
      curr.map((e) => {
        const st = edgeStyle(statusForNode(e.source as string, ctx));
        return { ...e, animated: st.animated, style: st.style };
      }),
    );
  }, [ctx, layoutNodeById, setNodes, setEdges]);

  /** Re-fit the viewport after a structural change (deferred a frame for measurement). */
  useEffect(() => {
    if (!pendingFitRef.current) return;
    if (selectedWorker) {
      pendingFitRef.current = false;
      return;
    }
    const inst = rfInstanceRef.current;
    if (!inst) return;
    pendingFitRef.current = false;
    const handle = requestAnimationFrame(() => {
      try {
        inst.fitView({ padding: 0.2, duration: 400 });
      } catch {
        /* instance torn down between frames — ignore */
      }
    });
    return () => cancelAnimationFrame(handle);
  }, [layout.signature, selectedWorker]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.type === 'worker') selectWorker(node.id);
    },
    [selectWorker],
  );

  const onInit = useCallback((instance: ReactFlowInstance) => {
    rfInstanceRef.current = instance;
  }, []);

  const fitView = useCallback(() => {
    rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 });
  }, []);

  const collapseCompleted = useCallback(() => {
    const roots = findCompletedBranchRoots(structuralNodes, (id) => meta.get(id)?.status ?? 'pending');
    const doneGroups = groups
      .filter((g) => g.memberIds.length > 0 && g.memberIds.every((m) => meta.get(m)?.status === 'done'))
      .map((g) => g.id);
    setCollapsedSubtrees((prev) => {
      const next = new Set(prev);
      for (const r of roots) next.add(r);
      return next;
    });
    if (doneGroups.length > 0) {
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        for (const g of doneGroups) next.add(g);
        return next;
      });
    }
  }, [structuralNodes, meta, groups]);

  const expandAll = useCallback(() => {
    setCollapsedSubtrees(new Set());
    setCollapsedGroups(new Set());
  }, []);

  const hasCollapsed = collapsedGroups.size > 0 || collapsedSubtrees.size > 0;

  /**
   * Task #201: deep-link selection — pan to the selected node when an external
   * selection occurs (e.g. clicking a Sub-planning row).
   */
  const lastCenteredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedWorker) {
      lastCenteredRef.current = null;
      return;
    }
    if (lastCenteredRef.current === selectedWorker) return;

    const tryCenter = (): boolean => {
      const inst = rfInstanceRef.current;
      if (!inst) return false;
      const node = inst.getNode(selectedWorker);
      if (!node) return false;
      const width = node.measured?.width ?? node.width ?? 160;
      const height = node.measured?.height ?? node.height ?? 60;
      const cx = node.position.x + width / 2;
      const cy = node.position.y + height / 2;
      const currentZoom = inst.getViewport().zoom;
      inst.setCenter(cx, cy, { zoom: Math.max(currentZoom, 1), duration: 500 });
      lastCenteredRef.current = selectedWorker;
      return true;
    };

    if (tryCenter()) return;
    const handle = requestAnimationFrame(() => {
      tryCenter();
    });
    return () => cancelAnimationFrame(handle);
  }, [selectedWorker]);

  if (layout.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
        No active workflow
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={onNodeClick}
      onInit={onInit}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.05}
      proOptions={{ hideAttribution: true }}
      className="bg-zinc-950"
    >
      <Background color="#27272a" gap={20} />

      <Panel position="top-left" className="!m-2 flex gap-1">
        <button
          type="button"
          onClick={fitView}
          title="Zoom to fit"
          className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800/90 px-2 py-1 text-[11px] text-zinc-300 shadow-lg transition-colors hover:bg-zinc-700"
        >
          <Maximize2 className="h-3 w-3" />
          Fit
        </button>
        <button
          type="button"
          onClick={collapseCompleted}
          title="Collapse completed branches"
          className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800/90 px-2 py-1 text-[11px] text-zinc-300 shadow-lg transition-colors hover:bg-zinc-700"
        >
          <FoldVertical className="h-3 w-3" />
          Collapse done
        </button>
        {hasCollapsed && (
          <button
            type="button"
            onClick={expandAll}
            title="Expand all collapsed nodes"
            className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800/90 px-2 py-1 text-[11px] text-zinc-300 shadow-lg transition-colors hover:bg-zinc-700"
          >
            <UnfoldVertical className="h-3 w-3" />
            Expand all
          </button>
        )}
      </Panel>

      <MiniMap
        pannable
        zoomable
        position="bottom-left"
        className="!bottom-[52px] !left-4 !rounded-md !border !border-zinc-700 !bg-zinc-900 !shadow-lg"
        maskColor="rgba(9, 9, 11, 0.7)"
        nodeColor={(n) => {
          if (n.type === 'groupContainer') return 'transparent';
          const status = (n.data as { status?: string } | undefined)?.status ?? 'pending';
          return miniMapColors[status] ?? '#71717a';
        }}
        nodeStrokeWidth={2}
      />

      <Controls
        showInteractive={false}
        position="bottom-right"
        className="!bg-zinc-800 !border-zinc-700 !shadow-lg !bottom-[52px] !right-4 [&>button]:!bg-zinc-800 [&>button]:!border-zinc-700 [&>button]:!text-zinc-400 [&>button:hover]:!bg-zinc-700"
      />
    </ReactFlow>
  );
}
