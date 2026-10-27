import { isCurrentUserLocation } from "./user-location.js";
import { getHallAdjacencyView } from "../map/hall-adjacency.js";
import { getSurveyBlockedEdges } from "./survey-routing.js";
import { getStairPartitionBlockedEdges } from "./stair-partition-routing.js";

const EPS = 1e-7;
const finitePoint = (p) =>
  Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(Number.isFinite);
const failure = (code, message) => ({ ok: false, code, message });
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (a, b, c) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const ringEdges = (ring) =>
  ring.map((a, i) => [a, ring[(i + 1) % ring.length]]);
function onSegment(p, a, b) {
  return (
    Math.abs(cross(a, b, p)) <= EPS &&
    p[0] >= Math.min(a[0], b[0]) - EPS &&
    p[0] <= Math.max(a[0], b[0]) + EPS &&
    p[1] >= Math.min(a[1], b[1]) - EPS &&
    p[1] <= Math.max(a[1], b[1]) + EPS
  );
}
function intersects(a, b, c, d) {
  const x = cross(a, b, c),
    y = cross(a, b, d),
    z = cross(c, d, a),
    w = cross(c, d, b);
  return (
    (((x > EPS && y < -EPS) || (x < -EPS && y > EPS)) &&
      ((z > EPS && w < -EPS) || (z < -EPS && w > EPS))) ||
    onSegment(a, c, d) ||
    onSegment(b, c, d) ||
    onSegment(c, a, b) ||
    onSegment(d, a, b)
  );
}
function inRing(p, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (const [a, b] of ringEdges(ring)) {
    if (onSegment(p, a, b)) return false;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
function inside(p, area) {
  return (
    inRing(p, area.points) &&
    !(area.holes || []).some(
      (h) => inRing(p, h) || ringEdges(h).some(([a, b]) => onSegment(p, a, b)),
    )
  );
}
/** A temporary endpoint is a snapshot selected by the user, not a catalogue room. */
export function makeCurrentRouteEndpoint(location, { now = Date.now() } = {}) {
  if (!isCurrentUserLocation(location, now))
    return failure(
      "location-unavailable",
      "Получите свежую геопозицию или уточните своё место на карте.",
    );
  if (
    !location.campusId ||
    !location.floorId ||
    !finitePoint(location.point) ||
    (location.source === "gps" &&
      !["manual", "manual-view-selection"].includes(location.floorEvidence))
  )
    return failure(
      "location-floor-unknown",
      "Откройте свой этаж и уточните точку на плане, чтобы начать маршрут.",
    );
  return {
    ok: true,
    endpoint: {
      kind: "user-location",
      campusId: location.campusId,
      floorId: location.floorId,
      label: "Моё местоположение",
      selectedAt: now,
      location: { ...location, point: location.point.slice(0, 2) },
    },
  };
}

/** Exact source-area containment plus a fully visible local connector. No
 * nearest-room assignment and no interpolation through a wall, hole or door. */
export function attachCurrentRouteEndpoint(
  graph,
  endpoint,
  sourceFloor,
  key = "from",
) {
  if (endpoint?.kind !== "user-location") return { ok: true, graph, endpoint };
  const selected = makeCurrentRouteEndpoint(endpoint.location, {
    now: endpoint.selectedAt,
  });
  if (!selected.ok) return selected;
  const location = endpoint.location;
  if (
    sourceFloor?.id !== location.floorId ||
    sourceFloor.campusId !== graph.campusId ||
    location.campusId !== graph.campusId
  )
    return failure(
      "location-floor-unavailable",
      "Для этой точки не найден выбранный план этажа. Уточните своё место.",
    );
  const floor = getHallAdjacencyView(sourceFloor);
  if (
    floor.footprints?.length &&
    !floor.footprints.some((p) => inside(location.point, p))
  )
    return failure(
      "location-area-unavailable",
      "Точка находится вне пола выбранного плана. Уточните её на карте.",
    );
  const areas = (floor.polygons || []).filter((p) => inside(location.point, p));
  if (areas.length !== 1)
    return failure(
      "location-area-unavailable",
      "Отметьте точное место внутри коридора, холла или помещения на плане.",
    );
  const area = areas[0];
  if (["stairs", "elevator", "lift"].includes(area.kind))
    return failure(
      "location-on-transition",
      "Начните маршрут с площадки или коридора рядом с лестницей.",
    );
  if (
    (area.building &&
      location.building &&
      area.building !== location.building) ||
    (area.building &&
      Number.isFinite(location.physicalLevel) &&
      floor.buildingLevels?.[area.building] !== location.physicalLevel)
  )
    return failure(
      "location-context-mismatch",
      "Точка находится в другом корпусе или на другом физическом этаже. Уточните её на плане.",
    );
  const areaId =
    area.sourcePolygonId || area.sourceAreaId || area.roomId || area.id;
  const boundaries = [area.points, ...(area.holes || [])].flatMap(ringEdges);
  const barriers = [...(floor.walls || []), ...(floor.doors || [])].filter(
    (b) => finitePoint(b.a) && finitePoint(b.b),
  );
  if (
    barriers.some((barrier) => onSegment(location.point, barrier.a, barrier.b))
  )
    return failure(
      "location-connector-unavailable",
      "Точка находится на стене или границе двери. Отметьте место внутри прохода.",
    );
  const protectedAreas = (floor.polygons || []).filter(
    (p) => p !== area && ["stairs", "elevator", "lift"].includes(p.kind),
  );
  const clear = (node) => {
    if (!inside(node.position, area)) return false;
    if (distance(location.point, node.position) < EPS) return true;
    if (
      boundaries.some(([a, b]) =>
        intersects(location.point, node.position, a, b),
      )
    )
      return false;
    if (
      barriers.some((b) => intersects(location.point, node.position, b.a, b.b))
    )
      return false;
    return !protectedAreas.some(
      (p) =>
        inside(location.point, p) ||
        inside(node.position, p) ||
        ringEdges(p.points).some(([a, b]) =>
          intersects(location.point, node.position, a, b),
        ),
    );
  };
  const sourceNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const blocked = new Set([
    ...getSurveyBlockedEdges(graph),
    ...getStairPartitionBlockedEdges(graph),
  ]);
  const candidates = [];
  for (const edge of graph.edges) {
    if (
      !edge.eligible ||
      edge.ephemeral ||
      edge.kind !== "corridor" ||
      blocked.has(edge.id) ||
      !Number.isFinite(edge.cost) ||
      edge.cost < 0
    )
      continue;
    const a = sourceNodes.get(edge.from),
      b = sourceNodes.get(edge.to);
    if (
      !a ||
      !b ||
      a.floorId !== location.floorId ||
      b.floorId !== location.floorId ||
      a.areaId !== areaId ||
      b.areaId !== areaId ||
      !finitePoint(a.position) ||
      !finitePoint(b.position)
    )
      continue;
    if (
      [a, b].some(
        (node) =>
          (node.building &&
            location.building &&
            node.building !== location.building) ||
          (Number.isFinite(node.physicalLevel) &&
            Number.isFinite(location.physicalLevel) &&
            node.physicalLevel !== location.physicalLevel),
      )
    )
      continue;
    const dx = b.position[0] - a.position[0],
      dy = b.position[1] - a.position[1],
      square = dx * dx + dy * dy;
    if (square < EPS * EPS) continue;
    const fraction = Math.max(
      0,
      Math.min(
        1,
        ((location.point[0] - a.position[0]) * dx +
          (location.point[1] - a.position[1]) * dy) /
          square,
      ),
    );
    const position = [
      a.position[0] + fraction * dx,
      a.position[1] + fraction * dy,
    ];
    const gap = distance(location.point, position);
    if (gap <= 12 && clear({ position }))
      candidates.push({ edge, a, b, fraction, position, gap });
  }
  candidates.sort(
    (a, b) => a.gap - b.gap || a.edge.id.localeCompare(b.edge.id),
  );
  const target = candidates[0];
  if (!target)
    return failure(
      "location-connector-unavailable",
      "Из этой точки нет проверенного короткого выхода к графу. Уточните место ближе к известному проходу.",
    );
  const id = `user-location:${key}`,
    nodeId = `${id}:snapshot`,
    projectionId = `${id}:source-projection`;
  const node = {
    id: nodeId,
    position: location.point.slice(0, 2),
    floorId: location.floorId,
    areaId,
    roomId: null,
    kind: "waypoint",
    building: area.building || location.building || null,
    physicalLevel:
      location.physicalLevel ?? floor.buildingLevels?.[area.building] ?? null,
    sourceLevel: floor.level,
    endpointKind: "user-location",
  };
  const projection = {
    ...node,
    id: projectionId,
    position: target.position,
    endpointKind: "source-edge-projection",
  };
  const connector = {
    id: `${id}:connector`,
    from: nodeId,
    to: projectionId,
    kind: "corridor",
    eligible: true,
    bidirectional: true,
    cost: target.gap,
    distanceMeters: graph.units === "meters" ? target.gap : null,
    source: "validated-local-user-connector",
    ephemeral: true,
    areaId,
  };
  const partial = (from, to, fraction, suffix) => ({
    ...target.edge,
    id: `${id}:partial:${suffix}`,
    from,
    to,
    cost: target.edge.cost * fraction,
    distanceMeters: Number.isFinite(target.edge.distanceMeters)
      ? target.edge.distanceMeters * fraction
      : null,
    source: "source-edge-partial",
    originalSourceEdgeId: target.edge.id,
    ephemeral: true,
  });
  const connectors = [
    connector,
    partial(target.a.id, projectionId, target.fraction, "before"),
    partial(projectionId, target.b.id, 1 - target.fraction, "after"),
  ];
  const record = {
    nodeId,
    label: endpoint.label,
    kind: "circulation",
    floorId: location.floorId,
    building: node.building,
    physicalLevel: node.physicalLevel,
    originAreaId: areaId,
    endpointKind: "user-location",
  };
  return {
    ok: true,
    graph: {
      ...graph,
      nodes: [...graph.nodes, node, projection],
      edges: [...graph.edges, ...connectors],
      rooms: { ...graph.rooms, [id]: record },
    },
    endpoint: { ...endpoint, id },
    connectorIds: connectors.map((e) => e.id),
  };
}
