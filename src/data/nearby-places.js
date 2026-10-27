import { getSurveyBlockedEdges } from "./survey-routing.js";
import { getStairPartitionBlockedEdges } from "./stair-partition-routing.js";
import { isCurrentUserLocation } from "./user-location.js";
import { placeLocation } from "./place-location.js";

const prepared = new WeakMap();
const circulation = new Set(["entrance", "circulation", "corridor", "hall"]);
const vertical = new Set(["stairs", "elevator", "lift"]);
const finitePoint = (point) =>
  Array.isArray(point) &&
  point.length >= 2 &&
  point.slice(0, 2).every(Number.isFinite);

class MinHeap {
  values = [];
  push(value) {
    let i = this.values.length;
    this.values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.values[parent].cost <= value.cost) break;
      this.values[i] = this.values[parent];
      i = parent;
    }
    this.values[i] = value;
  }
  pop() {
    const first = this.values[0];
    const last = this.values.pop();
    if (this.values.length) {
      let i = 0;
      while (i * 2 + 1 < this.values.length) {
        let child = i * 2 + 1;
        if (
          child + 1 < this.values.length &&
          this.values[child + 1].cost < this.values[child].cost
        )
          child++;
        if (this.values[child].cost >= last.cost) break;
        this.values[i] = this.values[child];
        i = child;
      }
      this.values[i] = last;
    }
    return first;
  }
}

function prepare(graph) {
  if (prepared.has(graph)) return prepared.get(graph);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
  const blocked = new Set([
    ...getSurveyBlockedEdges(graph),
    ...getStairPartitionBlockedEdges(graph),
  ]);
  for (const edge of graph.edges) {
    if (
      !edge.eligible ||
      blocked.has(edge.id) ||
      !nodes.has(edge.from) ||
      !nodes.has(edge.to) ||
      !Number.isFinite(edge.cost) ||
      edge.cost < 0
    )
      continue;
    adjacency.get(edge.from).push({ id: edge.to, edge });
    if (edge.bidirectional)
      adjacency.get(edge.to).push({ id: edge.from, edge });
  }
  const value = { nodes, adjacency };
  prepared.set(graph, value);
  return value;
}

/** One search over existing directed edges. Candidate facilities can be entered
 * but never crossed to reach another facility. No coordinate-to-graph snapping. */
export function rankGraphPlaces(records, position, graph) {
  const origin = graph?.rooms?.[position?.placeId];
  if (
    !origin ||
    (origin.floorId && origin.floorId !== position.floorId) ||
    position.campusId !== graph.campusId ||
    !graph.nodes?.length ||
    graph.status === "unavailable"
  )
    return null;
  const { nodes, adjacency } = prepare(graph);
  if (!nodes.has(origin.nodeId)) return null;
  const targets = new Set(
    records
      .filter(
        (room) => room.campusId === graph.campusId && graph.rooms[room.id],
      )
      .map((room) => room.id),
  );
  const costs = new Map([[origin.nodeId, 0]]);
  const details = new Map([[origin.nodeId, { distance: 0, transitions: 0 }]]);
  const heap = new MinHeap();
  heap.push({ id: origin.nodeId, cost: 0 });
  while (heap.values.length) {
    const current = heap.pop();
    if (current.cost !== costs.get(current.id)) continue;
    const currentNode = nodes.get(current.id);
    const currentRoom = graph.rooms[currentNode.areaId];
    for (const next of adjacency.get(current.id)) {
      const node = nodes.get(next.id);
      const room = graph.rooms[node.areaId];
      if (
        room &&
        node.areaId !== position.placeId &&
        !targets.has(node.areaId) &&
        !circulation.has(room.kind)
      )
        continue;
      if (
        currentRoom &&
        currentNode.areaId !== position.placeId &&
        targets.has(currentNode.areaId) &&
        !circulation.has(currentRoom.kind) &&
        node.areaId !== currentNode.areaId
      )
        continue;
      const cost = current.cost + next.edge.cost;
      if (cost >= (costs.get(next.id) ?? Infinity)) continue;
      const prior = details.get(current.id);
      const transition =
        vertical.has(next.edge.kind) || currentNode.floorId !== node.floorId;
      costs.set(next.id, cost);
      details.set(next.id, {
        distance:
          prior.distance +
          (transition
            ? 0
            : Math.hypot(
                node.position[0] - currentNode.position[0],
                node.position[1] - currentNode.position[1],
              )),
        transitions: prior.transitions + Number(transition),
      });
      heap.push({ id: next.id, cost });
    }
  }
  const items = records.map((room) => {
    const nodeId = graph.rooms[room.id]?.nodeId;
    const detail = details.get(nodeId);
    const reachable = detail != null;
    return {
      room,
      reachable,
      cost: costs.get(nodeId) ?? null,
      distanceMeters:
        reachable && graph.units === "meters" && !detail.transitions
          ? detail.distance
          : null,
      horizontalMeters:
        reachable && graph.units === "meters" ? detail.distance : null,
      minutes:
        reachable && graph.units === "meters"
          ? Math.max(
              1,
              Math.ceil((detail.distance / 1.1 + detail.transitions * 30) / 60),
            )
          : null,
      transitions: detail?.transitions ?? null,
      distanceKind: reachable ? "route" : null,
    };
  });
  items.sort(
    (a, b) =>
      Number(b.reachable) - Number(a.reachable) ||
      (a.cost ?? Infinity) - (b.cost ?? Infinity) ||
      String(a.room.label).localeCompare(String(b.room.label), "ru", {
        numeric: true,
      }),
  );
  return {
    mode: "routes",
    items,
    nearest: items.find((entry) => entry.reachable) || null,
    unreachableCount: items.filter((entry) => !entry.reachable).length,
  };
}

function floorFor(manifest, room) {
  return manifest?.campuses
    ?.find((campus) => campus.id === room?.campusId)
    ?.floors?.find((floor) => floor.id === room?.floorId);
}

/** A point without a verified room attachment only supports a straight-line
 * comparison on a known physical floor, never an indoor route claim. */
export function rankNearbyPlaces(
  records,
  { position, manifest, graph, now = Date.now() } = {},
) {
  if (
    !position ||
    !["manual", "gps"].includes(position.source) ||
    !isCurrentUserLocation(position, now) ||
    !position.floorId ||
    !finitePoint(position.point)
  ) {
    return {
      mode: "no-location",
      items: records.map((room) => ({ room })),
      nearest: null,
    };
  }
  const byGraph =
    position.source === "manual" &&
    graph &&
    rankGraphPlaces(records, position, graph);
  if (byGraph) return byGraph;
  const originFloor = floorFor(manifest, position);
  const originLevel = Number.isFinite(position.physicalLevel)
    ? position.physicalLevel
    : placeLocation(position, originFloor).physicalLevel;
  const items = records.map((room) => {
    const level = placeLocation(room, floorFor(manifest, room)).physicalLevel;
    const comparable =
      Number.isFinite(originLevel) &&
      originLevel === level &&
      room.campusId === position.campusId &&
      finitePoint(room.center);
    return {
      room,
      distanceMeters: comparable
        ? Math.hypot(
            room.center[0] - position.point[0],
            room.center[1] - position.point[1],
          )
        : null,
      distanceKind: comparable ? "straight-line" : null,
    };
  });
  items.sort(
    (a, b) =>
      Number(b.distanceMeters != null) - Number(a.distanceMeters != null) ||
      (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity),
  );
  return {
    mode: "straight-line",
    floorContext:
      position.floorEvidence === "manual-view-selection" ? "view" : "confirmed",
    items,
    nearest: items.find((entry) => entry.distanceMeters != null) || null,
  };
}

export function nearbyDistanceLabel(entry) {
  if (entry?.distanceKind === "straight-line")
    return `≈ ${Math.round(entry.distanceMeters)} м по прямой · проходы не учтены`;
  if (entry?.distanceKind === "route") {
    if (entry.distanceMeters === 0) return "Вы здесь";
    if (entry.distanceMeters == null && entry.minutes == null)
      return "Путь по карте · длина не установлена";
    return entry.distanceMeters != null
      ? `≈ ${Math.round(entry.distanceMeters)} м по карте`
      : entry.horizontalMeters > 0
        ? `от ${Math.round(entry.horizontalMeters)} м по карте · с переходами · ≈ ${entry.minutes} мин`
        : `≈ ${entry.minutes} мин по карте · с переходом между этажами`;
  }
  return "Путь от вашей точки не подтверждён";
}
