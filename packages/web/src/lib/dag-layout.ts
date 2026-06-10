/**
 * Pure DAG layout engine for the orchestration graph (Task #233).
 *
 * Extracted from `DAGVisualization` so the expensive structural work
 * (topological layering, branch-collapse dominator analysis, macro-group
 * substitution) is framework-agnostic, unit-testable, and — crucially —
 * memoizable on *structure* alone. Per-tick status/progress changes never
 * re-run this code; the component overlays live status onto the stable
 * positions instead, so hundreds of nodes don't trigger a full re-layout
 * on every event.
 */

export interface LayoutGraphNode {
  id: string;
  type: string;
  label: string;
  dependsOn: string[];
}

/** A macro phase → expanded sub-DAG cluster, derived client-side from events. */
export interface DagGroup {
  /** Stable group id (the originating macro node id). */
  id: string;
  title: string;
  /** Ids of the spliced sub-nodes that belong to this group. */
  memberIds: string[];
}

export interface BuildLayoutOptions {
  groups?: DagGroup[];
  collapsedGroups?: ReadonlySet<string>;
  collapsedSubtrees?: ReadonlySet<string>;
  colGap?: number;
  rowGap?: number;
}

export type LayoutNodeKind = 'worker' | 'groupSummary' | 'groupContainer';

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  kind: LayoutNodeKind;
  /** Original graph node id this position maps to (worker kind only). */
  refId?: string;
  label: string;
  nodeType: string;
  /** group id for groupSummary / groupContainer kinds. */
  groupId?: string;
  /** Members represented by a groupSummary, or hidden descendants of a collapsed worker. */
  memberIds?: string[];
  /** True when this worker has a collapsible (dominated) subtree. */
  collapsible?: boolean;
  /** True when this worker's subtree is currently collapsed. */
  collapsed?: boolean;
  /** Number of descendants hidden behind a collapsed worker. */
  hiddenCount?: number;
  /** Container geometry (groupContainer kind only). */
  width?: number;
  height?: number;
}

export interface PositionedEdge {
  id: string;
  source: string;
  target: string;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  /** Structural signature — changes only when positions could change. */
  signature: string;
}

const DEFAULT_COL_GAP = 320;
const DEFAULT_ROW_GAP = 100;
const NODE_W = 230;
const NODE_H = 72;
const GROUP_PAD = 24;
const GROUP_HEADER = 34;

interface WorkNode {
  id: string;
  dependsOn: Set<string>;
  order: number;
  /** group this logical node clusters with (for stable ordering / hulls). */
  groupKey: string;
}

function buildForwardAdjacency(nodes: Map<string, WorkNode>): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const id of nodes.keys()) adj.set(id, []);
  for (const n of nodes.values()) {
    for (const dep of n.dependsOn) {
      const list = adj.get(dep);
      if (list) list.push(n.id);
    }
  }
  return adj;
}

function rootIds(nodes: Map<string, WorkNode>): string[] {
  const roots: string[] = [];
  for (const n of nodes.values()) {
    if (n.dependsOn.size === 0) roots.push(n.id);
  }
  return roots;
}

/**
 * Nodes that are *exclusively* downstream of `rootId` — i.e. every path from a
 * graph root to them passes through `rootId` (the dominated subtree). These are
 * the nodes safe to hide when collapsing `rootId`, because nothing else depends
 * on them through another route.
 */
export function computeExclusiveDownstream(
  nodes: Map<string, WorkNode>,
  rootId: string,
): Set<string> {
  if (!nodes.has(rootId)) return new Set();
  const adj = buildForwardAdjacency(nodes);

  // Forward reachable from rootId (its descendants).
  const descendants = new Set<string>();
  const stack = [...(adj.get(rootId) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === rootId || descendants.has(cur)) continue;
    descendants.add(cur);
    for (const next of adj.get(cur) ?? []) stack.push(next);
  }
  if (descendants.size === 0) return new Set();

  // Reachable from any root WITHOUT traversing rootId.
  const reachable = new Set<string>();
  const roots = rootIds(nodes).filter((r) => r !== rootId);
  const q = [...roots];
  while (q.length) {
    const cur = q.pop()!;
    if (cur === rootId || reachable.has(cur)) continue;
    reachable.add(cur);
    for (const next of adj.get(cur) ?? []) {
      if (next !== rootId) q.push(next);
    }
  }

  const exclusive = new Set<string>();
  for (const d of descendants) {
    if (!reachable.has(d)) exclusive.add(d);
  }
  return exclusive;
}

function toWorkNodes(nodes: LayoutGraphNode[]): Map<string, WorkNode> {
  const present = new Set(nodes.map((n) => n.id));
  const map = new Map<string, WorkNode>();
  nodes.forEach((n, i) => {
    map.set(n.id, {
      id: n.id,
      dependsOn: new Set((n.dependsOn ?? []).filter((d) => present.has(d) && d !== n.id)),
      order: i,
      groupKey: '',
    });
  });
  return map;
}

/**
 * Layer the graph with a stable topological sort (matches the legacy grid
 * semantics) and assign x/y. Group members are clustered within their layer so
 * expanded-group hulls stay tidy.
 */
function layerAndPosition(
  nodes: Map<string, WorkNode>,
  colGap: number,
  rowGap: number,
): Map<string, { x: number; y: number; layer: number }> {
  const placed = new Set<string>();
  const layers: string[][] = [];
  const total = nodes.size;
  const all = [...nodes.values()].sort((a, b) => a.order - b.order);

  while (placed.size < total) {
    const layer: string[] = [];
    for (const n of all) {
      if (placed.has(n.id)) continue;
      let ready = true;
      for (const dep of n.dependsOn) {
        if (!placed.has(dep)) {
          ready = false;
          break;
        }
      }
      if (ready) layer.push(n.id);
    }
    if (layer.length === 0) {
      // Cycle / dangling — place everything remaining to guarantee progress.
      for (const n of all) if (!placed.has(n.id)) layer.push(n.id);
    }
    // Cluster grouped members together, otherwise preserve original order.
    layer.sort((a, b) => {
      const na = nodes.get(a)!;
      const nb = nodes.get(b)!;
      if (na.groupKey !== nb.groupKey) {
        if (na.groupKey === '') return 1;
        if (nb.groupKey === '') return -1;
        return na.groupKey < nb.groupKey ? -1 : 1;
      }
      return na.order - nb.order;
    });
    layer.forEach((id) => placed.add(id));
    layers.push(layer);
  }

  const pos = new Map<string, { x: number; y: number; layer: number }>();
  layers.forEach((layer, layerIdx) => {
    layer.forEach((id, rowIdx) => {
      pos.set(id, { x: layerIdx * colGap, y: rowIdx * rowGap, layer: layerIdx });
    });
  });
  return pos;
}

/**
 * Build the full positioned layout from base graph nodes plus collapse state.
 * Pure: depends only on structure + collapse, never on live status — so the
 * caller can memoize it and overlay status separately.
 */
export function buildDagLayout(
  baseNodes: LayoutGraphNode[],
  opts: BuildLayoutOptions = {},
): LayoutResult {
  const colGap = opts.colGap ?? DEFAULT_COL_GAP;
  const rowGap = opts.rowGap ?? DEFAULT_ROW_GAP;
  const groups = opts.groups ?? [];
  const collapsedGroups = opts.collapsedGroups ?? new Set<string>();
  const collapsedSubtrees = opts.collapsedSubtrees ?? new Set<string>();

  const presentIds = new Set(baseNodes.map((n) => n.id));
  const labelOf = new Map(baseNodes.map((n) => [n.id, n.label] as const));
  const typeOf = new Map(baseNodes.map((n) => [n.id, n.type] as const));

  // Only groups with members actually present.
  const liveGroups = groups
    .map((g) => ({ ...g, memberIds: g.memberIds.filter((m) => presentIds.has(m)) }))
    .filter((g) => g.memberIds.length > 0);
  const memberToGroup = new Map<string, string>();
  for (const g of liveGroups) {
    for (const m of g.memberIds) memberToGroup.set(m, g.id);
  }

  const logical = toWorkNodes(baseNodes);
  for (const n of logical.values()) {
    const gk = memberToGroup.get(n.id);
    if (gk) n.groupKey = gk;
  }

  // ---- Group collapse: substitute members with a single summary node. ----
  const summaryMembers = new Map<string, string[]>();
  for (const g of liveGroups) {
    if (!collapsedGroups.has(g.id)) continue;
    const memberSet = new Set(g.memberIds);
    const summaryId = `group:${g.id}`;
    // External deps = member deps pointing outside the group.
    const externalDeps = new Set<string>();
    for (const m of memberSet) {
      const wn = logical.get(m);
      if (!wn) continue;
      for (const dep of wn.dependsOn) {
        if (!memberSet.has(dep)) externalDeps.add(dep);
      }
    }
    // Drop members, add the summary node.
    for (const m of memberSet) logical.delete(m);
    logical.set(summaryId, {
      id: summaryId,
      dependsOn: externalDeps,
      order: Math.min(...g.memberIds.map((m) => baseNodes.findIndex((b) => b.id === m))),
      groupKey: g.id,
    });
    summaryMembers.set(summaryId, g.memberIds);
    // Rewrite other nodes that depended on any member → depend on the summary.
    for (const wn of logical.values()) {
      if (wn.id === summaryId) continue;
      let touched = false;
      for (const dep of [...wn.dependsOn]) {
        if (memberSet.has(dep)) {
          wn.dependsOn.delete(dep);
          touched = true;
        }
      }
      if (touched) wn.dependsOn.add(summaryId);
    }
  }

  // ---- Subtree collapse: hide dominated descendants of collapsed nodes. ----
  const collapsibleByDescendants = new Map<string, Set<string>>();
  for (const id of logical.keys()) {
    const excl = computeExclusiveDownstream(logical, id);
    if (excl.size > 0) collapsibleByDescendants.set(id, excl);
  }

  const hidden = new Set<string>();
  const activeCollapsed = new Set<string>();
  for (const id of collapsedSubtrees) {
    if (!logical.has(id)) continue;
    const excl = collapsibleByDescendants.get(id);
    if (!excl || excl.size === 0) continue;
    activeCollapsed.add(id);
  }
  // A collapsed node nested inside another collapsed node's subtree is redundant.
  for (const id of activeCollapsed) {
    const excl = collapsibleByDescendants.get(id)!;
    for (const d of excl) hidden.add(d);
  }
  for (const id of [...activeCollapsed]) {
    if (hidden.has(id)) activeCollapsed.delete(id);
  }
  // Recompute hidden from the surviving collapsed roots only.
  hidden.clear();
  for (const id of activeCollapsed) {
    for (const d of collapsibleByDescendants.get(id)!) hidden.add(d);
  }

  if (hidden.size > 0) {
    for (const h of hidden) logical.delete(h);
    for (const wn of logical.values()) {
      for (const dep of [...wn.dependsOn]) {
        if (hidden.has(dep)) wn.dependsOn.delete(dep);
      }
    }
  }

  // ---- Layer & position the surviving logical graph. ----
  const positions = layerAndPosition(logical, colGap, rowGap);

  const outNodes: PositionedNode[] = [];
  for (const wn of logical.values()) {
    const p = positions.get(wn.id)!;
    if (wn.id.startsWith('group:')) {
      const gid = wn.id.slice('group:'.length);
      const g = liveGroups.find((x) => x.id === gid);
      outNodes.push({
        id: wn.id,
        x: p.x,
        y: p.y,
        kind: 'groupSummary',
        groupId: gid,
        label: g?.title ?? 'Phase',
        nodeType: 'PHASE',
        memberIds: summaryMembers.get(wn.id) ?? [],
      });
      continue;
    }
    const excl = collapsibleByDescendants.get(wn.id);
    const isCollapsed = activeCollapsed.has(wn.id);
    outNodes.push({
      id: wn.id,
      x: p.x,
      y: p.y,
      kind: 'worker',
      refId: wn.id,
      label: labelOf.get(wn.id) ?? wn.id,
      nodeType: typeOf.get(wn.id) ?? 'AGENT',
      collapsible: !!excl && excl.size > 0,
      collapsed: isCollapsed,
      hiddenCount: isCollapsed ? excl!.size : 0,
      memberIds: isCollapsed ? [...excl!] : undefined,
    });
  }

  // ---- Expanded-group hull containers. ----
  for (const g of liveGroups) {
    if (collapsedGroups.has(g.id)) continue;
    const memberPos = g.memberIds
      .filter((m) => logical.has(m))
      .map((m) => positions.get(m)!)
      .filter(Boolean);
    if (memberPos.length === 0) continue;
    const minX = Math.min(...memberPos.map((p) => p.x));
    const minY = Math.min(...memberPos.map((p) => p.y));
    const maxX = Math.max(...memberPos.map((p) => p.x));
    const maxY = Math.max(...memberPos.map((p) => p.y));
    outNodes.push({
      id: `groupbox:${g.id}`,
      x: minX - GROUP_PAD,
      y: minY - GROUP_PAD - GROUP_HEADER,
      kind: 'groupContainer',
      groupId: g.id,
      label: g.title,
      nodeType: 'PHASE',
      memberIds: g.memberIds,
      width: maxX - minX + NODE_W + GROUP_PAD * 2,
      height: maxY - minY + NODE_H + GROUP_PAD * 2 + GROUP_HEADER,
    });
  }

  // ---- Edges from the surviving logical graph. ----
  const outEdges: PositionedEdge[] = [];
  for (const wn of logical.values()) {
    for (const dep of wn.dependsOn) {
      outEdges.push({ id: `${dep}__${wn.id}`, source: dep, target: wn.id });
    }
  }

  const sig = [
    outNodes
      .map((n) => `${n.kind}:${n.id}@${n.x},${n.y}:${n.collapsed ? 'c' : ''}${n.hiddenCount ?? ''}`)
      .sort()
      .join('|'),
    outEdges.map((e) => e.id).sort().join('|'),
  ].join('::');

  return { nodes: outNodes, edges: outEdges, signature: sig };
}

/**
 * Find the highest-level done nodes whose entire dominated subtree is also done,
 * so "Collapse completed" can fold finished branches into summary nodes without
 * collapsing one inside another.
 */
export function findCompletedBranchRoots(
  baseNodes: LayoutGraphNode[],
  statusOf: (id: string) => string,
): string[] {
  const logical = toWorkNodes(baseNodes);
  const exclById = new Map<string, Set<string>>();
  for (const id of logical.keys()) {
    const excl = computeExclusiveDownstream(logical, id);
    if (excl.size > 0) exclById.set(id, excl);
  }

  const candidates: string[] = [];
  for (const [id, excl] of exclById) {
    if (statusOf(id) !== 'done') continue;
    let allDone = true;
    for (const d of excl) {
      if (statusOf(d) !== 'done') {
        allDone = false;
        break;
      }
    }
    if (allDone) candidates.push(id);
  }

  // Drop candidates that are nested inside another candidate's subtree.
  const candidateSet = new Set(candidates);
  return candidates.filter((id) => {
    for (const other of candidateSet) {
      if (other === id) continue;
      const excl = exclById.get(other);
      if (excl && excl.has(id)) return false;
    }
    return true;
  });
}
