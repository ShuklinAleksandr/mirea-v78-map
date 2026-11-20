import hallAdjacency from "./hall-adjacency.json" with { type: "json" };
import { createRouteTrackingSurfaceGuard } from "./route-tracking-surface.js";
import { getEntranceLayout } from "../map/entrance-layout.js";
import { getStairDisplayCutouts, getStairFootprints } from "../map/stairs.js";
import { getHallAdjacencyView } from "../map/hall-adjacency.js";
import { getStairPartitionView } from "../map/stair-partitions.js";
import { withLibraryPassageFloor } from "./library-passage.js";

const floorGeometry = new WeakMap();
const walkable = new Set([
  "corridor",
  "circulation",
  "unclassified",
  "entrance",
  "hall",
]);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pointValid = (p) =>
  Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

function prepareFloor(sourceFloor) {
  if (floorGeometry.has(sourceFloor)) return floorGeometry.get(sourceFloor);
  let prepared = null;
  try {
    const floor = withLibraryPassageFloor(getHallAdjacencyView(sourceFloor));
    const entrance = getEntranceLayout(sourceFloor);
    const regions = [
      ...getStairDisplayCutouts(floor),
      ...getStairFootprints(floor),
      ...(floor.userConfirmedDisplayAdjacency?.applied
        ? hallAdjacency.addedRoomRegions
        : []),
      ...getStairPartitionView(floor).partitions.flatMap((p) =>
        p.innerWall ? [{ points: p.innerWall.wallPoints }] : [],
      ),
      ...(entrance?.furnitureFootprints || []).map((points) => ({ points })),
      ...(floor.uncertaintyRegions || []),
    ];
    for (const marker of floor.transitions || []) {
      if (!["stairs", "lift", "elevator"].includes(marker.kind)) continue;
      const [x, y] = marker.position;
      regions.push({
        points: [
          [x - 1, y - 1],
          [x + 1, y - 1],
          [x + 1, y + 1],
          [x - 1, y + 1],
        ],
      });
    }
    const allowedAreas = new Set(
      floor.polygons
        .filter(
          (p) =>
            walkable.has(p.kind) &&
            (!p.roomId || p.kind !== "unclassified") &&
            !entrance?.sourcePolygonIds.slice(0, 2).includes(p.id),
        )
        .map((p) => p.sourcePolygonId || p.sourceAreaId || p.roomId || p.id),
    );
    const check = createRouteTrackingSurfaceGuard(sourceFloor, {
      cutouts: regions,
      requireSourceArea: true,
    });
    // A return trip and routes to neighbouring destinations reuse the same
    // corridor. Visibility is symmetric on this immutable floor plan.
    const visibility = new Map();
    prepared = {
      allowedAreas,
      clear(a, b, area) {
        const reversed = a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
        const key = reversed ? `${area}|${b}|${a}` : `${area}|${a}|${b}`;
        if (visibility.has(key)) return visibility.get(key);
        const clear = check(a, b, area);
        if (visibility.size >= 32000) visibility.clear();
        visibility.set(key, clear);
        return clear;
      },
    };
  } catch {
    // A source plan without complete obstacle geometry retains the graph path.
  }
  floorGeometry.set(sourceFloor, prepared);
  return prepared;
}

// Find the shortest visible polyline through the existing ordered vertices.
// Doors crossed by the route, transitions, direction restrictions, and context
// changes break the walkable run. A door node merely passed in a hall does not.
export function simplifyWalkingSegment(
  segment,
  route,
  sourceFloor,
  { blockedAreaIds = [] } = {},
) {
  const { nodes, points } = segment;
  if (
    !sourceFloor ||
    sourceFloor.id !== segment.floorId ||
    sourceFloor.units !== "meters" ||
    (route?.campusId && route.campusId !== sourceFloor.campusId) ||
    !Array.isArray(sourceFloor.walls) ||
    !Array.isArray(sourceFloor.doors) ||
    !Array.isArray(nodes) ||
    !Array.isArray(points) ||
    nodes.length !== points.length ||
    !nodes.length ||
    !Array.isArray(route?.edges) ||
    !nodes.every(
      (node, i) =>
        node?.floorId === segment.floorId &&
        pointValid(node.position) &&
        pointValid(points[i]) &&
        distance(node.position, points[i]) < 1e-7,
    )
  )
    return segment;
  const surface = prepareFloor(sourceFloor);
  if (!surface) return segment;
  const forbidden = new Set(blockedAreaIds);
  const pairs = new Set();
  for (const e of route.edges) {
    if (e.kind !== "corridor" || !e.eligible || !e.bidirectional || e.ephemeral)
      continue;
    pairs.add(e.from + "\0" + e.to);
    pairs.add(e.to + "\0" + e.from);
  }
  const costs = [0],
    previous = [0];
  let runStart = 0;
  for (let end = 1; end < points.length; end++) {
    const a = nodes[end - 1],
      b = nodes[end];
    previous[end] = end - 1;
    costs[end] = costs[end - 1] + distance(points[end - 1], points[end]);
    if (
      !pairs.has(a.id + "\0" + b.id) ||
      a.areaId !== b.areaId ||
      a.physicalLevel !== b.physicalLevel ||
      a.building !== b.building ||
      !surface.allowedAreas.has(b.areaId) ||
      forbidden.has(b.areaId)
    ) {
      runStart = end;
      continue;
    }
    for (let start = runStart; start < end - 1; start++) {
      const length = distance(points[start], points[end]);
      const cost = costs[start] + length;
      if (length < 1e-7 || cost >= costs[end] - 1e-7) continue;
      if (surface.clear(points[start], points[end], b.areaId)) {
        costs[end] = cost;
        previous[end] = start;
      }
    }
  }
  const indices = [];
  for (let index = points.length - 1; ; index = previous[index]) {
    indices.push(index);
    if (index === 0) break;
  }
  if (indices.length === points.length) return segment;
  indices.reverse();
  return {
    ...segment,
    straightened: true,
    nodes: indices.map((i) => nodes[i]),
    points: indices.map((i) => points[i]),
  };
}
