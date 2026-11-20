import { getJSON } from "./client.js";
import { attachCurrentRouteEndpoint } from "./current-route-origin.js";
import { getSurveyBlockedEdges } from "./survey-routing.js";
import { simplifyWalkingSegment } from "./route-simplification.js";
import {
  getStairOpeningBlockedEdges,
  getStairPartitionBlockedEdges,
} from "./stair-partition-routing.js";
import { withAIOutdoorInstructions } from "./outdoor-passage.js";
import { withLibraryPassageGraph } from "./library-passage.js";

import {
  stairEndpointCandidates,
  staircasePreferencePenalty,
} from "./stair-routing.js";

const prepared = new WeakMap();
const publicRoomKinds = new Set([
  "entrance",
  "circulation",
  "corridor",
  "hall",
]);
const verticalKinds = new Set(["stairs", "elevator", "lift"]);
const failure = (code, message) => ({ ok: false, code, message });
const pointDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Original graph only; the exporter retains rejected edges for audit. */
export function loadRouting(campusId) {
  if (!/^(v-78|v-86|s-20|mp-1)$/.test(campusId))
    return Promise.reject(new Error("Неизвестная площадка"));
  return getJSON(`/data/routing/${campusId}.json`);
}

function rootOf(components, i) {
  while (components[i] !== i) {
    components[i] = components[components[i]];
    i = components[i];
  }
  return i;
}

function prepare(graph) {
  if (prepared.has(graph)) return prepared.get(graph);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const count = graph.nodes.length;
  const indices = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const adjacency = Array.from({ length: count }, () => []);
  const restrictedArea = graph.nodes.map(({ areaId }) =>
    graph.rooms[areaId] && !publicRoomKinds.has(graph.rooms[areaId].kind)
      ? areaId
      : null,
  );
  const components = Int32Array.from({ length: count }, (_, i) => i);
  const surveyBlockedEdges = getSurveyBlockedEdges(graph);
  const stairOpeningBlockedEdges = getStairOpeningBlockedEdges(graph);
  const stairPartitionBlockedEdges = getStairPartitionBlockedEdges(graph);
  for (const edge of graph.edges) {
    if (
      !edge.eligible ||
      surveyBlockedEdges.has(edge.id) ||
      stairPartitionBlockedEdges.has(edge.id) ||
      stairOpeningBlockedEdges.has(edge.id) ||
      !nodes.has(edge.from) ||
      !nodes.has(edge.to) ||
      !Number.isFinite(edge.cost) ||
      edge.cost < 0
    )
      continue;
    const from = indices.get(edge.from),
      to = indices.get(edge.to);
    const penalty = staircasePreferencePenalty(graph, edge);
    adjacency[from].push({ to, edge, penalty });
    if (edge.bidirectional) adjacency[to].push({ to: from, edge, penalty });
    // Contract edges within public circulation or within one private room.
    // A route between these components can use only endpoint-room entrances.
    if (restrictedArea[from] === restrictedArea[to])
      components[rootOf(components, from)] = rootOf(components, to);
  }
  for (let i = 0; i < count; i++) components[i] = rootOf(components, i);
  const doorsByArea = new Map();
  for (let from = 0; from < count; from++) {
    for (const { to } of adjacency[from]) {
      const a = components[from],
        b = components[to];
      if (a === b) continue;
      for (const area of [restrictedArea[from], restrictedArea[to]]) {
        if (area == null) continue;
        let links = doorsByArea.get(area);
        if (!links) doorsByArea.set(area, (links = []));
        if (
          !links.some(([x, y]) => (x === a && y === b) || (x === b && y === a))
        )
          links.push([a, b]);
      }
    }
  }
  const result = {
    nodes,
    indices,
    adjacency,
    components,
    doorsByArea,
    restrictedArea,
    edgesById: new Map(graph.edges.map((edge) => [edge.id, edge])),
    isolated: null,
    // Searches are synchronous. Reuse graph-sized arrays; the generation
    // distinguishes initialized entries without clearing them for every route.
    generation: 0,
    seen: new Uint32Array(count),
    costs: new Float64Array(count),
    previous: new Int32Array(count),
    previousEdges: new Array(count),
    surveyBlockedEdgeIds: [...surveyBlockedEdges],
    stairPartitionBlockedEdgeIds: [...stairPartitionBlockedEdges],
    stairOpeningBlockedEdgeIds: [...stairOpeningBlockedEdges],
  };
  prepared.set(graph, result);
  return result;
}

// This undirected test can reject disconnected endpoints cheaply. Every edge
// Dijkstra may use either stays in one component or occurs in an endpoint's
// connector list. Directed edges and temporary closures are enforced later.
function canReachEndpoint(index, start, target, allowedAreas) {
  const a = index.components[start],
    b = index.components[target];
  if (a === b) return true;
  // Dijkstra may leave its starting node even if it is in an unlisted area.
  if (
    index.restrictedArea[start] &&
    !allowedAreas.includes(index.restrictedArea[start])
  )
    return true;
  const links = [];
  for (const area of new Set(allowedAreas))
    if (index.doorsByArea.has(area)) links.push(...index.doorsByArea.get(area));
  const reached = new Set([a]);
  let previousSize;
  do {
    previousSize = reached.size;
    for (const [from, to] of links) {
      if (reached.has(from)) reached.add(to);
      else if (reached.has(to)) reached.add(from);
    }
  } while (!reached.has(b) && reached.size > previousSize);
  return reached.has(b);
}

/** Diagnose only a truly isolated destination in the retained source graph.
 * Rejected, directed and runtime-blocked external edges still count as source
 * exits here: their existence must not be misreported as a missing entrance.
 * Internal edges are walked undirected for this diagnostic, never for routing.
 */
function isolatedRoomComponentSize(graph, index, roomId, anchorIndex) {
  if (graph.nodes[anchorIndex].areaId !== roomId) return null;
  if (!index.isolated) {
    const count = graph.nodes.length;
    const components = Int32Array.from({ length: count }, (_, i) => i);
    const hasExit = new Uint8Array(count);
    for (const edge of graph.edges) {
      const from = index.indices.get(edge.from),
        to = index.indices.get(edge.to);
      if (
        from != null &&
        to != null &&
        graph.nodes[from].areaId === graph.nodes[to].areaId
      )
        components[rootOf(components, from)] = rootOf(components, to);
      else {
        if (from != null) hasExit[from] = 1;
        if (to != null) hasExit[to] = 1;
      }
    }
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const root = rootOf(components, i);
      components[i] = root;
      sizes[root]++;
      hasExit[root] |= hasExit[i];
    }
    index.isolated = Uint32Array.from(components, (root) =>
      hasExit[root] ? 0 : sizes[root],
    );
  }
  return index.isolated[anchorIndex] || null;
}

class MinHeap {
  data = [];
  push(id, cost) {
    const value = { id, cost };
    let i = this.data.length;
    this.data.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[parent].cost <= cost) break;
      this.data[i] = this.data[parent];
      i = parent;
    }
    this.data[i] = value;
  }
  pop() {
    const first = this.data[0];
    const last = this.data.pop();
    if (this.data.length) {
      let i = 0;
      while (i * 2 + 1 < this.data.length) {
        let child = i * 2 + 1;
        if (
          child + 1 < this.data.length &&
          this.data[child + 1].cost < this.data[child].cost
        )
          child++;
        if (this.data[child].cost >= last.cost) break;
        this.data[i] = this.data[child];
        i = child;
      }
      this.data[i] = last;
    }
    return first;
  }
}

function roomKey(room) {
  return typeof room === "string" ? room : room?.roomId || room?.id;
}

function floorName(node) {
  if (node.physicalLevel != null)
    return node.physicalLevel === -1
      ? "цоколь"
      : `${node.physicalLevel} этаж${node.building ? `, корпус ${node.building}` : ""}`;
  return `уровень ${node.sourceLevel} плана`;
}

function doorwayPoint(a, b, room) {
  return {
    ...a,
    id: `doorway:${a.id}:${b.id}`,
    position: a.position.map((value, i) => (value + b.position[i]) / 2),
    roomId: room,
    kind: "door",
    sourceNodeIds: [a.id, b.id],
  };
}

function turnsForSegment(segment) {
  const points = segment.points;
  const cumulative = [0];
  for (let i = 1; i < points.length; i++)
    cumulative.push(
      cumulative.at(-1) + pointDistance(points[i - 1], points[i]),
    );
  const turns = [];
  let lastTurnDistance = -Infinity;
  for (let i = 1; i < points.length - 1; i++) {
    if (cumulative[i] - lastTurnDistance < 4) continue;
    let before = i - 1,
      after = i + 1;
    while (before > 0 && cumulative[i] - cumulative[before] < 2) before--;
    while (after < points.length - 1 && cumulative[after] - cumulative[i] < 2)
      after++;
    const a = points[before],
      b = points[i],
      c = points[after];
    const u = [b[0] - a[0], b[1] - a[1]],
      v = [c[0] - b[0], c[1] - b[1]];
    const angle = Math.atan2(
      u[0] * v[1] - u[1] * v[0],
      u[0] * v[0] + u[1] * v[1],
    );
    if (Math.abs(angle) < Math.PI * 0.25 || Math.abs(angle) > Math.PI * 0.9)
      continue;
    turns.push({
      kind: "turn",
      direction: angle > 0 ? "right" : "left",
      text: angle > 0 ? "Поверните направо" : "Поверните налево",
      floorId: segment.floorId,
      position: b,
    });
    lastTurnDistance = cumulative[i];
  }
  return turns;
}

/**
 * Deterministic Dijkstra on validated, directed source edges.
 * Room arguments are search-index records or catalogue IDs. No nearest-node
 * attachment, straight-line fallback, real-time positioning or access claims.
 */
export function findRoute(graph, fromRoom, toRoom, options = {}) {
  graph = withLibraryPassageGraph(graph);
  if (
    (fromRoom?.campusId && fromRoom.campusId !== graph.campusId) ||
    (toRoom?.campusId && toRoom.campusId !== graph.campusId)
  )
    return failure(
      "different-campus",
      "Между площадками нужен внешний маршрут. Выберите две точки на одной площадке.",
    );
  if (options.accessible || options.withoutStairs)
    return failure(
      "accessibility-unverified",
      "Данных о доступности проходов и лифтах недостаточно для такого маршрута.",
    );
  if (!graph.nodes?.length || graph.status === "unavailable")
    return failure(
      "graph-unavailable",
      "Для этой площадки нет исходного графа проходов. Можно посмотреть помещение на карте.",
    );
  for (const [key, endpoint] of [
    ["from", fromRoom],
    ["to", toRoom],
  ]) {
    if (endpoint?.kind !== "user-location") continue;
    const floor = options.floors?.find((item) => item.id === endpoint.floorId);
    const attached = attachCurrentRouteEndpoint(
      graph,
      endpoint,
      floor,
      key,
      options.blockedEdgeIds,
    );
    if (!attached.ok) return attached;
    graph = attached.graph;
    if (key === "from") fromRoom = attached.endpoint;
    else toRoom = attached.endpoint;
  }
  const fromId = roomKey(fromRoom);
  const toId = roomKey(toRoom);
  const origins = graph.rooms[fromId]
    ? [graph.rooms[fromId]]
    : stairEndpointCandidates(graph, fromRoom);
  const destinations = graph.rooms[toId]
    ? [graph.rooms[toId]]
    : stairEndpointCandidates(graph, toRoom);
  if (!origins?.length || !destinations?.length)
    return failure(
      "endpoint-unavailable",
      "У выбранного объекта нет подтверждённой точки в графе проходов. Выберите другую аудиторию.",
    );
  if (
    fromId === toId ||
    origins.some((from) => destinations.some((to) => from.nodeId === to.nodeId))
  )
    return failure("same-place", "Начало и конец совпадают.");
  let best = null;
  for (const from of origins) {
    for (const to of destinations) {
      const route = routeBetweenAnchors(graph, fromId, from, toId, to, options);
      if (
        !best ||
        (route.ok &&
          (!best.ok ||
            route.diagnostics.routingCost < best.diagnostics.routingCost))
      )
        best = route;
    }
  }
  return best;
}

function routeBetweenAnchors(graph, fromId, from, toId, to, options) {
  const index = prepare(graph);
  const {
    nodes,
    indices,
    adjacency,
    restrictedArea,
    costs,
    seen,
    previous,
    previousEdges,
    surveyBlockedEdgeIds,
    stairPartitionBlockedEdgeIds,
    stairOpeningBlockedEdgeIds,
  } = index;
  const startIndexInGraph = indices.get(from.nodeId);
  const targetIndex = indices.get(to.nodeId);
  if (startIndexInGraph == null || targetIndex == null)
    return failure(
      "endpoint-unavailable",
      "Точка отсутствует в графе проходов.",
    );
  const blockedEdgeIds = new Set(options.blockedEdgeIds || []);
  const hasClosures = blockedEdgeIds.size > 0;
  const preferStairs = options.preferStaircase !== false;
  if (index.generation === 0xffffffff) {
    seen.fill(0);
    index.generation = 0;
  }
  const generation = ++index.generation;
  const heap = new MinHeap();
  if (
    canReachEndpoint(index, startIndexInGraph, targetIndex, [
      fromId,
      toId,
      from.originAreaId,
      to.originAreaId,
    ])
  )
    heap.push(startIndexInGraph, 0);
  seen[startIndexInGraph] = generation;
  costs[startIndexInGraph] = 0;
  let visited = 0;
  while (heap.data.length) {
    const current = heap.pop();
    if (current.cost !== costs[current.id]) continue;
    visited++;
    if (current.id === targetIndex) break;
    for (const next of adjacency[current.id]) {
      if (hasClosures && blockedEdgeIds.has(next.edge.id)) continue;
      // Only the endpoints' own rooms may act as private walking areas.
      const area = restrictedArea[next.to];
      if (
        area != null &&
        area !== fromId &&
        area !== toId &&
        area !== from.originAreaId &&
        area !== to.originAreaId
      )
        continue;
      const cost =
        current.cost + next.edge.cost + (preferStairs ? next.penalty : 0);
      if (cost >= (seen[next.to] === generation ? costs[next.to] : Infinity))
        continue;
      seen[next.to] = generation;
      costs[next.to] = cost;
      previous[next.to] = current.id;
      previousEdges[next.to] = next.edge;
      heap.push(next.to, cost);
    }
  }
  if (startIndexInGraph === targetIndex || seen[targetIndex] !== generation) {
    const isolatedNodeCount = isolatedRoomComponentSize(
      graph,
      index,
      toId,
      targetIndex,
    );
    if (isolatedNodeCount != null)
      return {
        ...failure(
          "no-path",
          `У ${to.label || "выбранного помещения"} в исходном графе нет подтверждённого входа. Помещение есть на плане, но маршрут пока недоступен.`,
        ),
        reason: "target-isolated-source-component",
        details: {
          targetRoomId: toId,
          targetLabel: to.label || null,
          floorId: to.floorId,
          sourceComponentNodeCount: isolatedNodeCount,
        },
      };
    return failure(
      "no-path",
      "В исходных данных нет непрерывного допустимого пути между этими точками. Связь через стены не достраивается.",
    );
  }
  const graphNodes = [];
  const edges = [];
  for (let i = targetIndex; ; i = previous[i]) {
    graphNodes.push(graph.nodes[i]);
    if (i === startIndexInGraph) break;
    edges.push(previousEdges[i]);
  }
  graphNodes.reverse();
  edges.reverse();
  // Display the route between real source doorways when available. The full
  // anchor-to-anchor chain remains accessible as graphNodes/edges for QA.
  let startIndex = 0;
  let endIndex = graphNodes.length - 1;
  let startDoor = null;
  let endDoor = null;
  for (let i = 0; i < edges.length; i++) {
    const a = graphNodes[i],
      b = graphNodes[i + 1];
    if (edges[i].kind !== "door") continue;
    if (!startDoor && a.areaId === fromId && b.areaId !== fromId) {
      startDoor = doorwayPoint(a, b, fromId);
      startIndex = i + 1;
    }
    if (b.areaId === toId && a.areaId !== toId) {
      endDoor = doorwayPoint(b, a, toId);
      endIndex = i;
    }
  }
  const routeNodes =
    startIndex > endIndex
      ? [graphNodes[endIndex], graphNodes[startIndex]]
      : [
          ...(startDoor ? [startDoor] : []),
          ...graphNodes.slice(startIndex, endIndex + 1),
          ...(endDoor ? [endDoor] : []),
        ];
  // Adjacent rooms use the opposite sides of one physical door. Keep the
  // actual short crossing and its direction. Neighbour-room directions also
  // need the source edge to establish that each endpoint really is a door.
  if (startDoor && endDoor && startIndex === endIndex + 1) {
    for (const [i, door] of [startDoor, endDoor].entries()) {
      routeNodes[i] = {
        ...routeNodes[i],
        kind: "door",
        sourceNodeIds: door.sourceNodeIds,
        sourceDoorEdgeId: edges[endIndex].id,
      };
    }
  }
  const segments = [];
  const transitions = [];
  for (let i = 0; i < routeNodes.length; i++) {
    const node = routeNodes[i];
    const previousNode = routeNodes[i - 1];
    const transitionEdge =
      previousNode &&
      edges.find(
        (edge) =>
          verticalKinds.has(edge.kind) &&
          ((edge.from === previousNode.id && edge.to === node.id) ||
            (edge.to === previousNode.id && edge.from === node.id)),
      );
    if (
      !previousNode ||
      previousNode.floorId !== node.floorId ||
      transitionEdge
    ) {
      segments.push({ floorId: node.floorId, points: [], nodes: [] });
      if (previousNode) {
        // Do not compare a known physical floor with an unknown source level.
        // These are different numbering systems in V-78.
        const comparablePhysicalLevels =
          node.building &&
          node.building === previousNode.building &&
          node.physicalLevel != null &&
          previousNode.physicalLevel != null;
        const ascending = comparablePhysicalLevels
          ? node.physicalLevel > previousNode.physicalLevel
          : node.sourceLevel > previousNode.sourceLevel;
        const label =
          previousNode.floorId === node.floorId
            ? "Пройдите по лестничному переходу"
            : `${ascending ? "Поднимитесь" : "Спуститесь"} на ${floorName(node)}`;
        transitions.push({
          fromFloorId: previousNode.floorId,
          toFloorId: node.floorId,
          point: previousNode.position,
          targetPoint: node.position,
          label,
          kind: transitionEdge?.kind || "stairs",
          sourceEdgeId: transitionEdge?.id,
        });
      }
    }
    segments.at(-1).points.push(node.position);
    segments.at(-1).nodes.push(node);
  }
  if (options.walkingFloors?.length) {
    const blockedAreaIds = new Set();
    if (blockedEdgeIds.size) {
      for (const id of blockedEdgeIds) {
        const edge = index.edgesById.get(id);
        if (!edge) continue;
        blockedAreaIds.add(nodes.get(edge.from)?.areaId);
        blockedAreaIds.add(nodes.get(edge.to)?.areaId);
      }
    }
    for (const [index, segment] of segments.entries()) {
      const floor = options.walkingFloors.find(
        (plan) => plan.id === segment.floorId,
      );
      segments[index] = simplifyWalkingSegment(
        segment,
        { campusId: graph.campusId, edges },
        floor,
        { blockedAreaIds },
      );
    }
  }
  let horizontalDistance = 0;
  const steps = [
    {
      kind: "start",
      text: `Начните у ${from.label}${startDoor ? " · у двери" : ""}`,
      floorId: routeNodes[0].floorId,
      position: routeNodes[0].position,
    },
  ];
  for (const segment of segments) {
    for (let i = 1; i < segment.points.length; i++)
      horizontalDistance += pointDistance(
        segment.points[i - 1],
        segment.points[i],
      );
    const segmentSteps = [];
    if (segment.points.length > 1)
      segmentSteps.push({
        kind: "walk",
        text: `Следуйте по выделенному пути · ${floorName(segment.nodes[0])}`,
        floorId: segment.floorId,
        position: segment.points[0],
      });
    segmentSteps.push(...turnsForSegment(segment));
    steps.push(...withAIOutdoorInstructions(graph, segment, segmentSteps));
    const transition = transitions.find(
      (t) =>
        t.fromFloorId === segment.floorId &&
        pointDistance(t.point, segment.points.at(-1)) < 0.001,
    );
    if (transition)
      steps.push({
        kind: transition.kind,
        text: transition.label,
        floorId: transition.fromFloorId,
        targetFloorId: transition.toFloorId,
        position: transition.point,
      });
  }
  steps.push({
    kind: "arrive",
    text: `${to.label}${endDoor ? " · вход в помещение" : " · точка из плана"}`,
    floorId: routeNodes.at(-1).floorId,
    position: routeNodes.at(-1).position,
  });
  const metric = graph.units === "meters";
  return {
    ok: true,
    campusId: graph.campusId,
    start: {
      floorId: routeNodes[0].floorId,
      point: routeNodes[0].position,
      roomId: from.endpointKind === "user-location" ? null : fromId,
      endpointKind: from.endpointKind || "place",
      label: from.label,
    },
    end: {
      floorId: routeNodes.at(-1).floorId,
      point: routeNodes.at(-1).position,
      roomId: to.endpointKind === "user-location" ? null : toId,
      endpointKind: to.endpointKind || "place",
      label: to.label,
    },
    nodes: segments.flatMap((segment) => segment.nodes),
    graphNodes,
    edges,
    segments,
    transitions,
    steps,
    // Unknown stair geometry does not become an invented measured distance.
    distanceMeters: metric && !transitions.length ? horizontalDistance : null,
    horizontalDistanceMeters: metric ? horizontalDistance : null,
    durationMinutes: metric
      ? Math.max(
          1,
          Math.ceil((horizontalDistance / 1.1 + transitions.length * 30) / 60),
        )
      : null,
    durationModel:
      "Оценка: 1,1 м/с по плану и 30 секунд на лестничный переход; без учёта ожидания и ограничений.",
    distanceStatus: transitions.length
      ? "stair-length-unknown"
      : "source-plan-estimate",
    estimated: true,
    navigationMode: "manual",
    diagnostics: {
      visitedNodes: visited,
      routingCost: costs[targetIndex],
      stairPreferencePenalty: edges.reduce(
        (sum, edge) =>
          sum +
          staircasePreferencePenalty(
            graph,
            edge,
            options.preferStaircase !== false,
          ),
        0,
      ),
      sourceEdges: edges.filter(
        (edge) => !edge.ephemeral || edge.originalSourceEdgeId,
      ).length,
      localConnectorIds: edges
        .filter((edge) => edge.source === "validated-local-user-connector")
        .map((edge) => edge.id),
      surveyBlockedEdgeIds,
      stairPartitionBlockedEdgeIds,
      stairOpeningBlockedEdgeIds,
    },
  };
}
