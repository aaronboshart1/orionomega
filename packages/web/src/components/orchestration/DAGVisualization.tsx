'use client';

import { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  useNodesState,
  useEdgesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useOrchestrationStore, type GraphNode } from '@/stores/orchestration';
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

export function DAGVisualization() {
  const graphState = useOrchestrationStore((s) => s.graphState);
  const selectWorker = useOrchestrationStore((s) => s.selectWorker);

  const { rfNodes, rfEdges } = useMemo(() => {
    if (!graphState) return { rfNodes: [], rfEdges: [] };
    return computeLayout(graphState.nodes);
  }, [graphState]);

  const [, , onNodesChange] = useNodesState(rfNodes);
  const [, , onEdgesChange] = useEdgesState(rfEdges);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      selectWorker(node.id);
    },
    [selectWorker],
  );

  if (!graphState) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
        No active workflow
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={onNodeClick}
      nodeTypes={nodeTypes}
      fitView
      proOptions={{ hideAttribution: true }}
      className="bg-zinc-950"
    >
      <Background color="#27272a" gap={20} />
      <Controls
        showInteractive={false}
        className="!bg-zinc-800 !border-zinc-700 !shadow-lg [&>button]:!bg-zinc-800 [&>button]:!border-zinc-700 [&>button]:!text-zinc-400 [&>button:hover]:!bg-zinc-700"
      />
      <MiniMap
        nodeColor={(node) => {
          const status = (node.data as Record<string, unknown>)?.status;
          if (status === 'running') return '#3b82f6';
          if (status === 'done') return '#22c55e';
          if (status === 'error') return '#ef4444';
          return '#3f3f46';
        }}
        maskColor="rgba(0,0,0,0.7)"
        className="!bg-zinc-900 !border-zinc-700"
      />
    </ReactFlow>
  );
}
