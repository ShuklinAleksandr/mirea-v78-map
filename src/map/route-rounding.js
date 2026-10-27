const EPSILON = 1e-7;
const walkableKinds = new Set([
  "corridor",
  "circulation",
  "hall",
  "entrance",
  "unclassified",
]);
const protectedKinds = new Set(["door", "stairs", "elevator", "lift"]);
const cross = (a, b, c) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const bounds = (points) => [
  Math.min(...points.map((p) => p[0])),
  Math.min(...points.map((p) => p[1])),
  Math.max(...points.map((p) => p[0])),
  Math.max(...points.map((p) => p[1])),
];
const overlap = (a, b) =>
  a[0] <= b[2] + EPSILON &&
  a[2] >= b[0] - EPSILON &&
  a[1] <= b[3] + EPSILON &&
  a[3] >= b[1] - EPSILON;
const edges = (ring) => ring.map((a, i) => [a, ring[(i + 1) % ring.length]]);

function onSegment(p, a, b) {
  return (
    Math.abs(cross(a, b, p)) <= EPSILON &&
    p[0] >= Math.min(a[0], b[0]) - EPSILON &&
    p[0] <= Math.max(a[0], b[0]) + EPSILON &&
    p[1] >= Math.min(a[1], b[1]) - EPSILON &&
    p[1] <= Math.max(a[1], b[1]) + EPSILON
  );
}

function intersects(a, b, c, d) {
  const x = cross(a, b, c),
    y = cross(a, b, d),
    z = cross(c, d, a),
    w = cross(c, d, b);
  return (
    (((x > EPSILON && y < -EPSILON) || (x < -EPSILON && y > EPSILON)) &&
      ((z > EPSILON && w < -EPSILON) || (z < -EPSILON && w > EPSILON))) ||
    onSegment(c, a, b) ||
    onSegment(d, a, b) ||
    onSegment(a, c, d) ||
    onSegment(b, c, d)
  );
}

function inRing(point, ring) {
  let inside = false;
  for (const [a, b] of edges(ring)) {
    if (onSegment(point, a, b)) return false;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

function inTriangle(point, triangle) {
  const values = edges(triangle).map(([a, b]) => cross(a, b, point));
  return (
    values.every((v) => v >= -EPSILON) || values.every((v) => v <= EPSILON)
  );
}

function inPolygon(point, polygon) {
  return (
    inRing(point, polygon.points) &&
    !(polygon.holes || []).some(
      (hole) =>
        inRing(point, hole) ||
        edges(hole).some(([a, b]) => onSegment(point, a, b)),
    )
  );
}

function triangleClear(triangle, polygon, barriers) {
  if (!triangle.every((p) => inPolygon(p, polygon))) return false;
  const sides = edges(triangle);
  const box = bounds(triangle);
  // The entire Bezier control triangle must fit, not just sampled points.
  // A narrow hole or a concave notch cannot hide between curve samples.
  for (const ring of [polygon.points, ...(polygon.holes || [])])
    for (const [a, b] of edges(ring))
      if (
        overlap(box, bounds([a, b])) &&
        (inTriangle(a, triangle) ||
          sides.some(([c, d]) => intersects(a, b, c, d)))
      )
        return false;
  for (const barrier of barriers)
    if (
      overlap(box, barrier.bounds) &&
      (inTriangle(barrier.a, triangle) ||
        inTriangle(barrier.b, triangle) ||
        sides.some(([a, b]) => intersects(a, b, barrier.a, barrier.b)))
    )
      return false;
  return true;
}

function overlapsRegion(triangle, ring) {
  return (
    triangle.some((point) => inRing(point, ring)) ||
    ring.some((point) => inTriangle(point, triangle)) ||
    edges(ring).some(([a, b]) =>
      edges(triangle).some(([c, d]) => intersects(a, b, c, d)),
    )
  );
}

/** Display-only corner fillets; graph nodes, doors, metrics and steps stay intact.
 * Each fillet is contained in one original source area with two proven corridor
 * edges. Unknown areas, stairs, area boundaries and reversals retain the path.
 */
export function roundWalkingRoute(
  segment,
  route,
  floor,
  protectedAreaIds = [],
  protectedRegions = [],
) {
  const points = segment.points.map((point) => [point[0], point[1]]);
  const unchanged = { ...segment, points, roundedCorners: 0 };
  if (
    floor?.id !== segment.floorId ||
    floor.units !== "meters" ||
    !segment.nodes ||
    segment.nodes.length !== points.length ||
    points.length < 3
  )
    return unchanged;
  const forbiddenAreas = new Set(protectedAreaIds);
  const corridorEdges = new Set();
  for (const edge of route?.edges || [])
    if (edge.kind === "corridor" && edge.eligible === true) {
      corridorEdges.add(`${edge.from}\u0000${edge.to}`);
      if (edge.bidirectional) corridorEdges.add(`${edge.to}\u0000${edge.from}`);
    }
  const areas = new Map();
  // A source container can be a whole hallway with a small staircase in one
  // corner. Protect its actual footprint and portals, not the entire hallway.
  const exclusions = [...protectedRegions];
  for (const point of (floor.transitions || [])
    .filter((transition) => protectedKinds.has(transition.kind))
    .map((transition) => transition.position)
    .filter(Boolean)) {
    const [x, z] = point;
    exclusions.push([
      [x - 1, z - 1],
      [x + 1, z - 1],
      [x + 1, z + 1],
      [x - 1, z + 1],
    ]);
  }
  for (const polygon of floor.polygons || []) {
    const id = polygon.roomId || polygon.id;
    if (
      !walkableKinds.has(polygon.kind) ||
      forbiddenAreas.has(id) ||
      forbiddenAreas.has(polygon.id)
    )
      continue;
    const list = areas.get(id) || [];
    list.push(polygon);
    areas.set(id, list);
  }
  const barriers = [...(floor.walls || []), ...(floor.doors || [])].map(
    (edge) => ({
      ...edge,
      bounds: bounds([edge.a, edge.b]),
    }),
  );
  const result = [points[0]];
  let roundedCorners = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const nodes = segment.nodes.slice(i - 1, i + 2);
    const [a, b, c] = points.slice(i - 1, i + 2);
    const areaId = nodes[1].areaId;
    const inLength = distance(a, b),
      outLength = distance(b, c);
    let curve = null;
    if (
      nodes.every(
        (node) => node.areaId === areaId && !protectedKinds.has(node.kind),
      ) &&
      corridorEdges.has(`${nodes[0].id}\u0000${nodes[1].id}`) &&
      corridorEdges.has(`${nodes[1].id}\u0000${nodes[2].id}`) &&
      inLength > EPSILON &&
      outLength > EPSILON
    ) {
      const u = [(b[0] - a[0]) / inLength, (b[1] - a[1]) / inLength];
      const v = [(c[0] - b[0]) / outLength, (c[1] - b[1]) / outLength];
      const angle = Math.acos(
        Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])),
      );
      // Keep at least 30% of every original leg between adjacent fillets.
      let cut = Math.min(0.75, inLength * 0.35, outLength * 0.35);
      while (angle > Math.PI / 25 && angle < (Math.PI * 3) / 4 && cut >= 0.06) {
        const entry = [b[0] - u[0] * cut, b[1] - u[1] * cut];
        const exit = [b[0] + v[0] * cut, b[1] + v[1] * cut];
        const triangle = [entry, b, exit];
        if (
          !exclusions.some((ring) => overlapsRegion(triangle, ring)) &&
          (areas.get(areaId) || []).some((polygon) =>
            triangleClear(triangle, polygon, barriers),
          )
        ) {
          const steps = Math.max(5, Math.ceil((angle / Math.PI) * 18));
          curve = [entry];
          for (let step = 1; step <= steps; step++) {
            const t = step / steps,
              s = 1 - t;
            curve.push([
              s * s * entry[0] + 2 * s * t * b[0] + t * t * exit[0],
              s * s * entry[1] + 2 * s * t * b[1] + t * t * exit[1],
            ]);
          }
          break;
        }
        cut /= 2;
      }
    }
    if (curve) {
      result.push(...curve);
      roundedCorners++;
    } else result.push(b);
  }
  result.push(points.at(-1));
  return { ...segment, points: result, roundedCorners };
}
