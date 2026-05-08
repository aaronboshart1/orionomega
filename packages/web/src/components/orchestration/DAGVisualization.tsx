'use client';

import { useMemo, useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type ReactFlowInstance,
  useNodesState,
  useEdgesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useOrchestrationStore, type GraphNode, type InlineDAGNode } from '@/stores/orchestration';
import { WorkerNode } from './WorkerNode';

const nodeTypes = { worker: WorkerNode };

function computeLayout(nodes: Record<string, GraphNode>) {
  const entries = Object.values(nodes);
  const layers: string[][] = [];
  const placed = new Set<string>();

  while (placed.size < entries.length) {
    const layer: string[] = [];
    for (const node of entries) {
      if (placed.has(node.id)) continue;
      const depsReady = node.dependsOn.every((d) => placed.has(d));
      if (depsReady) layer.push(node.id);
    }
    if (layer.length === 0) {
      for (const node of entries) {
        if (!placed.has(node.id)) layer.push(node.id);
      }
    }
    layer.forEach((id) => placed.add(id));
    layers.push(layer);
  }

  const rfNodes: Node[] = [];
  layers.forEach((layer, layerIdx) => {
    layer.forEach((nodeId, nodeIdx) => {
      const gn = nodes[nodeId];
      rfNodes.push({
        id: nodeId,
        type: 'worker',
        position: { x: layerIdx * 350, y: nodeIdx * 110 },
        data: {
          label: gn.label,
          nodeType: gn.type,
          status: gn.status,
          progress: gn.progress,
          model: gn.agent?.model,
        },
      });
    });
  });

  const rfEdges: Edge[] = [];
  for (const node of entries) {
    for (const dep of node.dependsOn) {
      const sourceNode = nodes[dep];
      rfEdges.push({
        id: `${dep}-${node.id}`,
        source: dep,
        target: node.id,
        animated: sourceNode?.status === 'running',
        style: {
          stroke:
            sourceNode?.status === 'done'
              ? '#22c55e'
              : sourceNode?.status === 'running'
                ? '#3b82f6'
                : '#3f3f46',
        },
      });
    }
  }

  return { rfNodes, rfEdges };
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

export function DAGVisualization() {
  const graphState = useOrchestrationStore((s) => s.graphState);
  const activeWorkflowId = useOrchestrationStore((s) => s.activeWorkflowId);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const selectWorker = useOrchestrationStore((s) => s.selectWorker);
  const selectedWorker = useOrchestrationStore((s) => s.selectedWorker);
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);

  const { rfNodes, rfEdges } = useMemo(() => {
    if (graphState) {
      return computeLayout(graphState.nodes);
    }
    // Fall back to InlineDAG nodes for live runs (graphState arrives only in event/status msgs)
    const activeDag = activeWorkflowId ? inlineDAGs[activeWorkflowId] : null;
    if (!activeDag || activeDag.nodes.length === 0) {
      return { rfNodes: [], rfEdges: [] };
    }
    return computeLayout(inlineNodesToGraphNodes(activeDag.nodes));
  }, [graphState, activeWorkflowId, inlineDAGs]);

  const [nodes, setNodes, onNodesChange] = useNodesState(rfNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(rfEdges);

  /**
   * Stable structural signature: changes only when the *set* of node ids or
   * edge ids changes (e.g. new layers stream in, or the active workflow
   * switches), not when a node's status/progress ticks. Used both to gate
   * wholesale array replacement (which interacts badly with React Flow's
   * measurement pass on large graphs) and to schedule a viewport re-fit so
   * newly-added nodes don't end up off-screen.
   */
  const structuralSignature = useMemo(() => {
    const nodeIds = rfNodes.map((n) => n.id).sort().join('|');
    const edgeIds = rfEdges.map((e) => e.id).sort().join('|');
    // Include the active workflow id so switching between two workflows that
    // happen to share node ids still counts as a structural change and
    // triggers a re-fit rather than silently keeping the old viewport.
    return `${activeWorkflowId ?? ''}::${nodeIds}::${edgeIds}`;
  }, [activeWorkflowId, rfNodes, rfEdges]);

  const prevSignatureRef = useRef<string>('');
  const pendingFitRef = useRef(false);

  /**
   * Sync store-derived nodes/edges into React Flow's internal state.
   *
   * - Structural change (new/removed nodes or edges, workflow switch):
   *   replace the arrays wholesale and schedule a viewport re-fit so the
   *   newly-grown graph stays on-screen.
   * - Data-only change (status, progress, model badge, edge animation):
   *   patch existing nodes/edges in place by id so React Flow keeps its
   *   internal measurements and doesn't tear mid-render. On a large
   *   streaming run this is what previously caused the canvas to go blank.
   */
  useEffect(() => {
    const signatureChanged = prevSignatureRef.current !== structuralSignature;
    if (signatureChanged) {
      const isFirstStructure = prevSignatureRef.current === '';
      prevSignatureRef.current = structuralSignature;
      setNodes(rfNodes);
      setEdges(rfEdges);
      if (!isFirstStructure) {
        // First mount is handled by the `fitView` prop on <ReactFlow>.
        pendingFitRef.current = true;
      }
      return;
    }
    // Data-only update — patch by id, preserving node identity & measurements.
    const nodeById = new Map(rfNodes.map((n) => [n.id, n]));
    const edgeById = new Map(rfEdges.map((e) => [e.id, e]));
    setNodes((curr) =>
      curr.map((n) => {
        const next = nodeById.get(n.id);
        return next ? { ...n, data: next.data } : n;
      }),
    );
    setEdges((curr) =>
      curr.map((e) => {
        const next = edgeById.get(e.id);
        return next ? { ...e, animated: next.animated, style: next.style } : e;
      }),
    );
  }, [structuralSignature, rfNodes, rfEdges, setNodes, setEdges]);

  /**
   * After a structural change, re-fit the viewport on the next frame so
   * React Flow has a chance to measure the new nodes. Skipped when a
   * deep-link selection is active so the selected-node `setCenter` effect
   * (Task #201) keeps winning.
   */
  useEffect(() => {
    if (!pendingFitRef.current) return;
    if (selectedWorker) {
      // Selection takes precedence; drop the pending fit so we don't fight it.
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
  }, [structuralSignature, selectedWorker]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      selectWorker(node.id);
    },
    [selectWorker],
  );

  const onInit = useCallback((instance: ReactFlowInstance) => {
    rfInstanceRef.current = instance;
  }, []);

  /**
   * Task #201: when an external selection occurs (e.g. clicking a row
   * in the Sub-planning panel), pan the viewport so the corresponding
   * DAG node is visible. The WorkerNode component already renders a
   * highlight ring when its id matches `selectedWorker`.
   *
   * Only re-runs on selection change (not on every nodes/edges update),
   * so live graph churn during a run doesn't keep snapping the viewport
   * back to the selected node. If the node isn't in the React Flow
   * instance yet on first attempt (e.g. user clicked a sub-planning row
   * before the new layer rendered), retry once on the next animation
   * frame so the deep-link still works.
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

  if (rfNodes.length === 0) {
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
      proOptions={{ hideAttribution: true }}
      className="bg-zinc-950"
    >
      <Background color="#27272a" gap={20} />
      <Controls
        showInteractive={false}
        position="bottom-right"
        className="!bg-zinc-800 !border-zinc-700 !shadow-lg !bottom-[52px] !right-4 [&>button]:!bg-zinc-800 [&>button]:!border-zinc-700 [&>button]:!text-zinc-400 [&>button:hover]:!bg-zinc-700"
      />
      <MiniMap
        nodeColor={(n) => {
          const status = (n.data as { status?: string }).status;
          if (status === 'running') return '#3b82f6';
          if (status === 'done') return '#22c55e';
          if (status === 'error') return '#ef4444';
          return '#52525b';
        }}
        maskColor="rgba(9,9,11,0.7)"
        position="top-right"
        className="!bg-zinc-900 !border !border-zinc-700 !rounded-md !shadow-lg"
        style={{ width: 120, height: 70 }}
      />
    </ReactFlow>
  );
}
