import { getJSON } from "./client.js";
import { attachCurrentRouteEndpoint } from "./current-route-origin.js";
import { getSurveyBlockedEdges } from "./survey-routing.js";
import { getStairPartitionBlockedEdges } from "./stair-partition-routing.js";

const prepared = new WeakMap();
const verticalKinds = new Set(["stairs", "elevator", "lift"]);
const failure = (code, message) => ({ ok: false, code, message });
const pointDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Original graph only; the exporter retains rejected edges for audit. */
export function loadRouting(campusId) {
  if (!/^(v-78|v-86|s-20|mp-1)$/.test(campusId))
    return Promise.reject(new Error("Неизвестная площадка"));
  return getJSON(`/data/routing/${campusId}.json`);
}

function prepare(graph) {
  if (prepared.has(graph)) return prepared.get(graph);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
  const surveyBlockedEdges = getSurveyBlockedEdges(graph);
  const stairPartitionBlockedEdges = getStairPartitionBlockedEdges(graph);
  for (const edge of graph.edges) {
    if (
      !edge.eligible ||
      surveyBlockedEdges.has(edge.id) ||
      stairPartitionBlockedEdges.has(edge.id) ||
      !nodes.has(edge.from) ||
      !nodes.has(edge.to) ||
      !Number.isFinite(edge.cost) ||
      edge.cost < 0
    )
      continue;
    adjacency.get(edge.from).push({ to: edge.to, edge });
    if (edge.bidirectional)
      adjacency.get(edge.to).push({ to: edge.from, edge });
  }
  const result = {
    nodes,
    adjacency,
    surveyBlockedEdgeIds: [...surveyBlockedEdges],
    stairPartitionBlockedEdgeIds: [...stairPartitionBlockedEdges],
  };
  prepared.set(graph, result);
  return result;
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
    const attached = attachCurrentRouteEndpoint(graph, endpoint, floor, key);
    if (!attached.ok) return attached;
    graph = attached.graph;
    if (key === "from") fromRoom = attached.endpoint;
    else toRoom = attached.endpoint;
  }
  const fromId = roomKey(fromRoom);
  const toId = roomKey(toRoom);
  const from = graph.rooms[fromId];
  const to = graph.rooms[toId];
  if (!from || !to)
    return failure(
      "endpoint-unavailable",
      "У выбранного объекта нет подтверждённой точки в графе проходов. Выберите другую аудиторию.",
    );
  if (fromId === toId)
    return failure("same-place", "Начало и конец совпадают.");
  const {
    nodes,
    adjacency,
    surveyBlockedEdgeIds,
    stairPartitionBlockedEdgeIds,
  } = prepare(graph);
  if (!nodes.has(from.nodeId) || !nodes.has(to.nodeId))
    return failure(
      "endpoint-unavailable",
      "Точка отсутствует в графе проходов.",
    );
  const permittedRooms = new Set(
    [fromId, toId, from.originAreaId, to.originAreaId].filter(Boolean),
  );
  const costs = new Map([[from.nodeId, 0]]);
  const previous = new Map();
  const heap = new MinHeap();
  heap.push(from.nodeId, 0);
  let visited = 0;
  while (heap.data.length) {
    const current = heap.pop();
    if (current.cost !== costs.get(current.id)) continue;
    visited++;
    if (current.id === to.nodeId) break;
    for (const next of adjacency.get(current.id)) {
      const target = nodes.get(next.to);
      // Do not silently use an unrelated classroom/toilet as a shortcut.
      if (
        graph.rooms[target.areaId] &&
        !permittedRooms.has(target.areaId) &&
        !["entrance", "circulation", "corridor", "hall"].includes(
          graph.rooms[target.areaId].kind,
        )
      )
        continue;
      const cost = current.cost + next.edge.cost;
      if (cost >= (costs.get(next.to) ?? Infinity)) continue;
      costs.set(next.to, cost);
      previous.set(next.to, { node: current.id, edge: next.edge });
      heap.push(next.to, cost);
    }
  }
  if (!previous.has(to.nodeId))
    return failure(
      "no-path",
      "В исходных данных нет непрерывного допустимого пути между этими точками. Связь через стены не достраивается.",
    );
  const graphNodes = [];
  const edges = [];
  for (let id = to.nodeId; ; ) {
    graphNodes.push(nodes.get(id));
    if (id === from.nodeId) break;
    const link = previous.get(id);
    edges.push(link.edge);
    id = link.node;
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
  const segments = [];
  const transitions = [];
  let horizontalDistance = 0;
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
    } else {
      horizontalDistance += pointDistance(previousNode.position, node.position);
    }
    segments.at(-1).points.push(node.position);
    segments.at(-1).nodes.push(node);
  }
  const steps = [
    {
      kind: "start",
      text: `Начните у ${from.label}${startDoor ? " · у двери" : ""}`,
      floorId: routeNodes[0].floorId,
      position: routeNodes[0].position,
    },
  ];
  for (const segment of segments) {
    if (segment.points.length > 1)
      steps.push({
        kind: "walk",
        text: `Следуйте по выделенному пути · ${floorName(segment.nodes[0])}`,
        floorId: segment.floorId,
        position: segment.points[0],
      });
    steps.push(...turnsForSegment(segment));
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
    nodes: routeNodes,
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
      sourceEdges: edges.filter(
        (edge) => !edge.ephemeral || edge.originalSourceEdgeId,
      ).length,
      localConnectorIds: edges
        .filter((edge) => edge.source === "validated-local-user-connector")
        .map((edge) => edge.id),
      surveyBlockedEdgeIds,
      stairPartitionBlockedEdgeIds,
    },
  };
}
