import { getHallAdjacencyView } from "../map/hall-adjacency.js";
import { pickLocationSurface } from "../map/location-view.js";
import { getStairDisplayCutouts } from "../map/stairs.js";

const EPSILON = 1e-7;
const guards = new WeakMap();
const protectedKinds = new Set(["door", "stairs", "elevator", "lift"]);
const finitePoint = (point) =>
  Array.isArray(point) &&
  point.length >= 2 &&
  point.slice(0, 2).every(Number.isFinite);
const cross = (a, b, c) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const edges = (ring) => ring.map((a, i) => [a, ring[(i + 1) % ring.length]]);
const validRing = (ring) =>
  Array.isArray(ring) &&
  ring.length >= 3 &&
  ring.every(finitePoint) &&
  Math.abs(
    ring.reduce((sum, a, i) => {
      const b = ring[(i + 1) % ring.length];
      return sum + a[0] * b[1] - b[0] * a[1];
    }, 0),
  ) > EPSILON;
const validPolygon = (polygon) =>
  validRing(polygon?.points) &&
  (polygon.holes == null ||
    (Array.isArray(polygon.holes) && polygon.holes.every(validRing)));

function onSegment(point, a, b) {
  return (
    Math.abs(cross(a, b, point)) <= EPSILON &&
    point[0] >= Math.min(a[0], b[0]) - EPSILON &&
    point[0] <= Math.max(a[0], b[0]) + EPSILON &&
    point[1] >= Math.min(a[1], b[1]) - EPSILON &&
    point[1] <= Math.max(a[1], b[1]) + EPSILON
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
    onSegment(a, c, d) ||
    onSegment(b, c, d) ||
    onSegment(c, a, b) ||
    onSegment(d, a, b)
  );
}

function pointSegmentDistance(point, a, b) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1];
  const squared = dx * dx + dz * dz;
  const t = squared
    ? Math.max(
        0,
        Math.min(
          1,
          ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / squared,
        ),
      )
    : 0;
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dz);
}

function segmentDistance(a, b, c, d) {
  if (intersects(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}

function inRing(point, ring) {
  let inside = false;
  for (const [a, b] of edges(ring)) {
    if (onSegment(point, a, b)) return true;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

const inside = (point, polygon) =>
  inRing(point, polygon.points) &&
  !(polygon.holes || []).some((hole) => inRing(point, hole));
const crossesRing = (a, b, ring) =>
  edges(ring).some(([c, d]) => intersects(a, b, c, d));
const remainsInside = (a, b, polygon) =>
  inside(a, polygon) &&
  inside(b, polygon) &&
  ![polygon.points, ...(polygon.holes || [])].some((ring) =>
    crossesRing(a, b, ring),
  );

/** Build once per immutable source floor. This only rejects unsupported GPS
 * projections; it never changes the observed point or creates a route edge. */
export function createRouteTrackingSurfaceGuard(sourceFloor, options = {}) {
  if (
    !sourceFloor?.id ||
    !Array.isArray(sourceFloor.polygons) ||
    (sourceFloor.footprints != null &&
      !Array.isArray(sourceFloor.footprints)) ||
    (sourceFloor.walls != null && !Array.isArray(sourceFloor.walls)) ||
    (sourceFloor.doors != null && !Array.isArray(sourceFloor.doors))
  )
    return () => false;
  let floor, cutouts;
  try {
    floor = getHallAdjacencyView(sourceFloor);
    cutouts = options.cutouts ?? getStairDisplayCutouts(floor);
  } catch {
    return () => false;
  }
  const polygons = floor.polygons,
    footprints = floor.footprints || [],
    walls = floor.walls || [],
    doors = floor.doors || [];
  if (
    (!polygons.length && !footprints.length) ||
    !polygons.every(validPolygon) ||
    !footprints.every(validPolygon) ||
    !Array.isArray(cutouts) ||
    !cutouts.every(validPolygon) ||
    ![...walls, ...doors].every(
      (wall) => finitePoint(wall.a) && finitePoint(wall.b),
    )
  )
    return () => false;
  const holes = [...polygons, ...footprints].flatMap(
    (polygon) => polygon.holes || [],
  );
  const protectedAreas = polygons.filter((polygon) =>
    protectedKinds.has(polygon.kind),
  );
  return (point, projectedPoint) => {
    if (!finitePoint(point) || !finitePoint(projectedPoint)) return false;
    const same =
      Math.hypot(point[0] - projectedPoint[0], point[1] - projectedPoint[1]) <=
      EPSILON;
    if (
      !pickLocationSurface(floor, point, { cutouts }) ||
      !pickLocationSurface(floor, projectedPoint, { cutouts })
    )
      return false;
    if (
      [...cutouts, ...protectedAreas].some(
        (polygon) =>
          inside(point, polygon) ||
          inside(projectedPoint, polygon) ||
          (!same && crossesRing(point, projectedPoint, polygon.points)),
      ) ||
      holes.some(
        (hole) =>
          inRing(point, hole) ||
          inRing(projectedPoint, hole) ||
          (!same && crossesRing(point, projectedPoint, hole)),
      )
    )
      return false;
    if (
      walls.some(
        (wall) =>
          segmentDistance(point, projectedPoint, wall.a, wall.b) <=
          (Number.isFinite(wall.width) && wall.width > 0 ? wall.width : 0.2) /
            2 +
            EPSILON,
      ) ||
      doors.some((door) => intersects(point, projectedPoint, door.a, door.b))
    )
      return false;
    const pointAreas = polygons.filter((polygon) => inside(point, polygon));
    const projectedAreas = polygons.filter((polygon) =>
      inside(projectedPoint, polygon),
    );
    // An overlapping/ambiguous source area cannot select which parallel room
    // contains the observation, even when both points have the same x/z.
    if (pointAreas.length > 1 || projectedAreas.length > 1) return false;
    if (pointAreas.length || projectedAreas.length) {
      if (pointAreas[0] !== projectedAreas[0]) return false;
      if (!same && !remainsInside(point, projectedPoint, pointAreas[0]))
        return false;
    } else if (
      !same &&
      polygons.some((polygon) =>
        crossesRing(point, projectedPoint, polygon.points),
      )
    )
      return false;
    if (!footprints.length) return pointAreas.length === 1;
    const common = footprints.filter(
      (polygon) => inside(point, polygon) && inside(projectedPoint, polygon),
    );
    return common.some(
      (polygon) => same || remainsInside(point, projectedPoint, polygon),
    );
  };
}

/** Source floors are immutable after loading; a replaced floor gets a new
 * guard. Explicit options create an uncached guard for alternate cutouts. */
export function isRouteTrackingConnectorClear(
  sourceFloor,
  point,
  projectedPoint,
  options,
) {
  if (!sourceFloor || typeof sourceFloor !== "object") return false;
  if (options)
    return createRouteTrackingSurfaceGuard(sourceFloor, options)(
      point,
      projectedPoint,
    );
  if (!guards.has(sourceFloor))
    guards.set(sourceFloor, createRouteTrackingSurfaceGuard(sourceFloor));
  return guards.get(sourceFloor)(point, projectedPoint);
}
