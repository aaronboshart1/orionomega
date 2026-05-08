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

  // Sync store-derived nodes/edges into React Flow's internal state on every change
  useEffect(() => {
    setNodes(rfNodes);
  }, [rfNodes, setNodes]);

  useEffect(() => {
    setEdges(rfEdges);
  }, [rfEdges, setEdges]);

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
