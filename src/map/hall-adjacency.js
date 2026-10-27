import polygonClipping from "polygon-clipping";
import adjacency from "../data/hall-adjacency.json" with { type: "json" };

const epsilon = 1e-7;
const cached = new WeakMap();
const samePoint = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  Math.hypot(a[0] - b[0], a[1] - b[1]) < epsilon;
const sameRing = (a, b) =>
  Array.isArray(a) &&
  a.length === b.length &&
  a.every((point, i) => samePoint(point, b[i]));
const edges = (ring) =>
  ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length] }));
const ringArea = (ring) =>
  Math.abs(
    ring.reduce((sum, a, i) => {
      const b = ring[(i + 1) % ring.length];
      return sum + a[0] * b[1] - b[0] * a[1];
    }, 0),
  ) / 2;
const polygonArea = (rings) =>
  ringArea(rings[0]) -
  rings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0);
const sourceRings = (polygon) =>
  [polygon.points, ...(polygon.holes || [])].map((ring) =>
    ring.map((point) => [...point]),
  );
const openRing = (ring) => {
  const points = ring.map((point) => [...point]);
  if (points.length > 1 && samePoint(points[0], points.at(-1))) points.pop();
  return points;
};

function onSegment(point, segment) {
  const dx = segment.b[0] - segment.a[0],
    dz = segment.b[1] - segment.a[1];
  const length = Math.hypot(dx, dz);
  if (length < epsilon) return samePoint(point, segment.a);
  const x = point[0] - segment.a[0],
    z = point[1] - segment.a[1];
  const along = (x * dx + z * dz) / length;
  return (
    Math.abs(x * dz - z * dx) / length < epsilon &&
    along >= -epsilon &&
    along <= length + epsilon
  );
}

function matchesSource(floor) {
  if (
    floor?.campusId !== adjacency.campusId ||
    floor?.id !== adjacency.floorId ||
    !Array.isArray(floor.polygons) ||
    !Array.isArray(floor.walls) ||
    !floor.footprints?.length
  )
    return false;
  return Object.entries(adjacency.expectedPolygons).every(([id, expected]) => {
    const matching = floor.polygons.filter((polygon) => polygon.id === id);
    if (matching.length !== 1) return false;
    const polygon = matching[0];
    return (
      polygon.kind === expected.kind &&
      sameRing(polygon.points, expected.points) &&
      samePoint(polygon.center, expected.center) &&
      (polygon.holes || []).length === expected.holes.length &&
      expected.holes.every((ring, i) => sameRing(polygon.holes[i], ring))
    );
  });
}

const evidence = () => ({
  ...adjacency.evidence,
  sourceGeometrySha256: adjacency.sourceGeometrySha256,
  geometryStatus: "user-adjacency-approximate-dimensions",
  dimensions: "model-only-not-surveyed",
  atmPocket: "right-end-approximate-contour",
  exteriorContour: "original-footprint-retained",
});

/**
 * User-confirmed adjacency only. This does not edit the source floor, doors,
 * room centres or routing graph. Routing applies its separate eligibility view
 * from the same adjacency descriptor before displaying a route in this area.
 */
export function getHallAdjacencyView(floor) {
  if (!floor || typeof floor !== "object") return floor;
  if (cached.has(floor)) return cached.get(floor);
  if (!matchesSource(floor)) return floor;
  const buffetBoundary = {
    a: adjacency.buffetBoundary[0],
    b: adjacency.buffetBoundary[1],
  };
  const buffetWallIndex = floor.walls.findIndex(
    (wall) =>
      (samePoint(wall.a, buffetBoundary.a) &&
        samePoint(wall.b, buffetBoundary.b)) ||
      (samePoint(wall.a, buffetBoundary.b) &&
        samePoint(wall.b, buffetBoundary.a)),
  );
  // A complete native buffet wall must remain to replace duplicate subsegments.
  if (buffetWallIndex < 0) return floor;
  const sourceHall = floor.polygons.find(
    (polygon) => polygon.id === adjacency.hallPolygonId,
  );
  const sourceRooms = floor.polygons.filter((polygon) =>
    adjacency.roomIds.includes(polygon.id),
  );
  const replacePoint = (point) => {
    const index = adjacency.oldVertices
      .slice(0, 4)
      .findIndex((old) => samePoint(point, old));
    return index < 0 ? point : [...adjacency.projectedVertices[index]];
  };
  const footprintShapes = floor.footprints.map(sourceRings);
  const rooms = [];
  for (const polygon of sourceRooms) {
    const expanded = { ...polygon, points: polygon.points.map(replacePoint) };
    const clipped = polygonClipping.intersection(
      sourceRings(expanded),
      footprintShapes,
    );
    if (clipped.length !== 1 || polygonArea(clipped[0]) <= epsilon)
      return floor;
    // Clip the tiny left corner to the known concave exterior instead of
    // expanding the source slab. Front vertices and doors stay in place.
    rooms.push({
      ...polygon,
      points: openRing(clipped[0][0]).map(
        (point) =>
          polygon.points.find((source) => samePoint(source, point)) || point,
      ),
      holes: clipped[0].slice(1).map(openRing),
      geometryStatus: "user-adjacency-approximate-dimensions",
      displayEvidence: evidence(),
    });
  }
  // Subtract real expanded room shapes instead of moving the hall's ring onto
  // itself. This preserves holes and explicitly retains disconnected pockets.
  const components = polygonClipping
    .difference(sourceRings(sourceHall), ...rooms.map(sourceRings))
    .filter((rings) => polygonArea(rings) > epsilon)
    .sort((a, b) => polygonArea(b) - polygonArea(a));
  if (!components.length) return floor;
  const halls = components.map((rings, i) => {
    const points = openRing(rings[0]);
    return {
      ...sourceHall,
      id: i ? `${sourceHall.id}:display-pocket-${i}` : sourceHall.id,
      roomId: i ? sourceHall.roomId || sourceHall.id : sourceHall.roomId,
      center: i
        ? [
            points.reduce((sum, p) => sum + p[0], 0) / points.length,
            points.reduce((sum, p) => sum + p[1], 0) / points.length,
          ]
        : sourceHall.center,
      points,
      holes: rings.slice(1).map(openRing),
      sourcePolygonId: sourceHall.id,
      geometryStatus: "user-adjacency-approximate-dimensions",
      displayEvidence: evidence(),
    };
  });
  const sourceEdges = [...sourceRooms, sourceHall].flatMap((polygon) =>
    [polygon.points, ...(polygon.holes || [])].flatMap(edges),
  );
  const footprintEdges = floor.footprints.flatMap((polygon) =>
    [polygon.points, ...(polygon.holes || [])].flatMap(edges),
  );
  const roomEdges = rooms.flatMap((room) => edges(room.points));
  const walls = floor.walls
    .map((wall) => {
      if (
        !sourceEdges.some(
          (edge) => onSegment(wall.a, edge) && onSegment(wall.b, edge),
        )
      )
        return wall;
      if (
        footprintEdges.some(
          (edge) => onSegment(wall.a, edge) && onSegment(wall.b, edge),
        )
      )
        return wall;
      const a = replacePoint(wall.a),
        b = replacePoint(wall.b);
      if (a === wall.a && b === wall.b) return wall;
      return {
        ...wall,
        a,
        b,
        geometryStatus: "user-adjacency-approximate-dimensions",
        displayEvidence: evidence(),
      };
    })
    .filter(
      (wall, index) =>
        index === buffetWallIndex ||
        !(
          onSegment(wall.a, buffetBoundary) && onSegment(wall.b, buffetBoundary)
        ),
    );
  // The clipped left corner introduces one short rear edge. Keep the source
  // exterior walls and front door gaps; add only changed, uncovered rear edges.
  for (const edge of roomEdges) {
    if (onSegment(edge.a, buffetBoundary) && onSegment(edge.b, buffetBoundary))
      continue;
    if (
      sourceEdges.some(
        (source) => onSegment(edge.a, source) && onSegment(edge.b, source),
      ) ||
      walls.some((wall) => onSegment(edge.a, wall) && onSegment(edge.b, wall))
    )
      continue;
    walls.push({
      ...edge,
      source: "user-confirmed-display-adjacency",
      confidence: "approximate-dimensions",
      geometryStatus: "user-adjacency-approximate-dimensions",
      displayEvidence: evidence(),
    });
  }
  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const polygons = floor.polygons.flatMap((polygon) =>
    polygon.id === sourceHall.id
      ? halls
      : [roomById.get(polygon.id) || polygon],
  );
  const view = {
    ...floor,
    polygons,
    walls,
    userConfirmedDisplayAdjacency: {
      ...evidence(),
      applied: true,
      sourceHallId: sourceHall.id,
      roomIds: [...adjacency.roomIds],
      hallComponentIds: halls.map((hall) => hall.id),
    },
  };
  cached.set(floor, view);
  return view;
}
