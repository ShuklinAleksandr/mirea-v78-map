// Display-only selection. Source floors and their navigation graph stay intact.
const EPSILON = 0.004;
const finitePoint = (point) =>
  Array.isArray(point) &&
  point.length >= 2 &&
  point.slice(0, 2).every(Number.isFinite);

function segmentDistance(point, a, b) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared
    ? Math.max(
        0,
        Math.min(
          1,
          ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / lengthSquared,
        ),
      )
    : 0;
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dz);
}

function ringLocation(point, ring) {
  if (
    !finitePoint(point) ||
    !Array.isArray(ring) ||
    ring.length < 3 ||
    !ring.every(finitePoint)
  )
    return -1;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j],
      b = ring[i];
    if (segmentDistance(point, a, b) <= EPSILON) return 0;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside ? 1 : -1;
}

function containsPoint(polygon, point) {
  const location = ringLocation(point, polygon?.points);
  if (location < 0) return false;
  // Both outside and courtyard boundaries belong to the source outline.
  return !(polygon.holes || []).some((hole) => ringLocation(point, hole) > 0);
}

function overlapsPolygon(footprint, polygon) {
  return (
    (polygon.points || []).some((point) => containsPoint(footprint, point)) ||
    containsPoint(footprint, polygon.center)
  );
}

function containedPolygon(footprint, polygon) {
  return (
    polygon.points?.length >= 3 &&
    polygon.points.every((point) => containsPoint(footprint, point))
  );
}

function containedSegment(footprint, segment) {
  if (!finitePoint(segment.a) || !finitePoint(segment.b)) return false;
  const middle = [
    (segment.a[0] + segment.b[0]) / 2,
    (segment.a[1] + segment.b[1]) / 2,
  ];
  return [segment.a, middle, segment.b].every((point) =>
    containsPoint(footprint, point),
  );
}

/**
 * Omit a whole, separately represented source footprint only when it has named
 * rooms of another building and none of the requested building. A shared or
 * unclassified component is kept; no invented building boundary is introduced.
 */
export function getBuildingFloorView(floor, building) {
  if (!floor || !building || !floor.footprints?.length) return floor;
  const excluded = floor.footprints.filter((footprint) => {
    const owners = new Set(
      (floor.polygons || [])
        .filter(
          (polygon) => polygon.building && overlapsPolygon(footprint, polygon),
        )
        .map((polygon) => polygon.building),
    );
    return owners.size > 0 && !owners.has(building);
  });
  if (!excluded.length) return floor;
  const view = {
    ...floor,
    footprints: floor.footprints.filter(
      (footprint) => !excluded.includes(footprint),
    ),
  };
  if (Array.isArray(floor.polygons))
    view.polygons = floor.polygons.filter(
      (polygon) =>
        !excluded.some((footprint) => containedPolygon(footprint, polygon)),
    );
  for (const name of ["walls", "doors"]) {
    if (Array.isArray(floor[name]))
      view[name] = floor[name].filter(
        (segment) =>
          !excluded.some((footprint) => containedSegment(footprint, segment)),
      );
  }
  for (const name of ["markers", "transitions"]) {
    if (Array.isArray(floor[name]))
      view[name] = floor[name].filter(
        (marker) =>
          !excluded.some((footprint) =>
            containsPoint(
              footprint,
              marker.position || marker.center || marker.point,
            ),
          ),
      );
  }
  return view;
}

function segments(polygon) {
  return [polygon.points || [], ...(polygon.holes || [])].flatMap((ring) =>
    ring.map((a, i) => [a, ring[(i + 1) % ring.length]]),
  );
}

function commonLength(a, b, c, d) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    length = Math.hypot(dx, dz);
  if (length <= EPSILON) return 0;
  if (
    Math.abs(dx * (c[1] - a[1]) - dz * (c[0] - a[0])) / length > EPSILON ||
    Math.abs(dx * (d[1] - a[1]) - dz * (d[0] - a[0])) / length > EPSILON
  )
    return 0;
  const t0 = ((c[0] - a[0]) * dx + (c[1] - a[1]) * dz) / length;
  const t1 = ((d[0] - a[0]) * dx + (d[1] - a[1]) * dz) / length;
  return Math.max(
    0,
    Math.min(length, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)),
  );
}

function sharedBoundaryLength(polygon, other) {
  return segments(polygon).reduce(
    (sum, [a, b]) =>
      sum +
      segments(other).reduce(
        (part, [c, d]) => part + commonLength(a, b, c, d),
        0,
      ),
    0,
  );
}

/** IDs contributing complete polygons to camera/cutaway bounds, not ownership. */
export function getBuildingScopePolygonIds(floor, building) {
  const polygons = floor?.polygons || [];
  const own = polygons.filter((polygon) => polygon.building === building);
  const ids = new Set(own.map((polygon) => polygon.id));
  if (
    building !== "А" ||
    floor?.id !== "v-78-floor2" ||
    floor?.campusId !== "v-78"
  )
    return ids;
  const corridors = new Set(["v-78-floor2-area-29", "v-78-floor2-area-56"]);
  for (const polygon of polygons) {
    if (
      !corridors.has(polygon.id) ||
      polygon.kind !== "unclassified" ||
      polygon.building ||
      !polygon.points?.every(finitePoint)
    )
      continue;
    // These two native corridors have long exact boundaries against A rooms.
    // Fail closed if their source geometry or neighboring identities change.
    if (!own.some((other) => sharedBoundaryLength(polygon, other) > 0.1))
      continue;
    if (
      polygons.some(
        (other) =>
          other.building &&
          other.building !== building &&
          sharedBoundaryLength(polygon, other) > 0.1,
      )
    )
      continue;
    ids.add(polygon.id);
  }
  return ids;
}
