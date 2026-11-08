// Display-only selection. Source floors and their navigation graph stay intact.
const EPSILON = 0.004;
export const BUILDING_DISPLAY_MARGIN = 2.5;
const ringBoundsCache = new WeakMap();
const componentCache = new WeakMap();
const polygonContainmentCache = new WeakMap();
const segmentContainmentCache = new WeakMap();
const finitePoint = (point) =>
  Array.isArray(point) &&
  point.length >= 2 &&
  point.slice(0, 2).every(Number.isFinite);

function ringBounds(ring) {
  if (!Array.isArray(ring)) return null;
  if (!ringBoundsCache.has(ring))
    ringBoundsCache.set(
      ring,
      ring.length >= 3 && ring.every(finitePoint)
        ? [
            Math.min(...ring.map((point) => point[0])),
            Math.min(...ring.map((point) => point[1])),
            Math.max(...ring.map((point) => point[0])),
            Math.max(...ring.map((point) => point[1])),
          ]
        : null,
    );
  return ringBoundsCache.get(ring);
}

function boundsContainPoint(bounds, point) {
  return (
    bounds &&
    finitePoint(point) &&
    point[0] >= bounds[0] - EPSILON &&
    point[0] <= bounds[2] + EPSILON &&
    point[1] >= bounds[1] - EPSILON &&
    point[1] <= bounds[3] + EPSILON
  );
}

function boundsOverlap(a, b) {
  return (
    a &&
    b &&
    a[0] <= b[2] + EPSILON &&
    a[2] >= b[0] - EPSILON &&
    a[1] <= b[3] + EPSILON &&
    a[3] >= b[1] - EPSILON
  );
}

// build-data.py derives this union from exteriorEligible indoor polygons.
// The ordinary footprint can also join buildings through an outdoor sidewalk.
function indoorFootprints(floor) {
  return floor.exteriorFootprints?.length
    ? floor.exteriorFootprints
    : floor.footprints || [];
}

function buildingComponents(floor) {
  if (componentCache.has(floor)) return componentCache.get(floor);
  const named = (floor.polygons || []).filter((polygon) => polygon.building);
  const components = indoorFootprints(floor).map((footprint) => ({
    footprint,
    owners: new Set(
      named
        .filter((polygon) => overlapsPolygon(footprint, polygon))
        .map((polygon) => polygon.building),
    ),
  }));
  componentCache.set(floor, components);
  return components;
}

/** Read-only evidence for auditing display scopes, never room ownership. */
export function getBuildingFloorComponentScopes(floor, building) {
  return buildingComponents(floor)
    .filter(({ owners }) => !owners.size || owners.has(building))
    .map(({ footprint, owners }) => ({
      footprint,
      owners: [...owners],
      exclusive: owners.size === 1 && owners.has(building),
    }));
}

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
  if (!boundsContainPoint(ringBounds(ring), point)) return -1;
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
  if (!boundsOverlap(ringBounds(footprint.points), ringBounds(polygon.points)))
    return false;
  return (
    (polygon.points || []).some((point) => containsPoint(footprint, point)) ||
    containsPoint(footprint, polygon.center)
  );
}

function containedPolygon(footprint, polygon) {
  if (!boundsOverlap(ringBounds(footprint.points), ringBounds(polygon.points)))
    return false;
  let cache = polygonContainmentCache.get(footprint);
  if (!cache) polygonContainmentCache.set(footprint, (cache = new WeakMap()));
  if (cache.has(polygon)) return cache.get(polygon);
  const contained =
    polygon.points?.length >= 3 &&
    polygon.points.every((point) => containsPoint(footprint, point));
  cache.set(polygon, contained);
  return contained;
}

function containedSegment(footprint, segment) {
  if (!finitePoint(segment.a) || !finitePoint(segment.b)) return false;
  const bounds = ringBounds(footprint.points);
  // Outside bounds are already constant-time; retain cache entries only for
  // actual candidate pairs, not every wall against every distant component.
  if (
    !boundsContainPoint(bounds, segment.a) ||
    !boundsContainPoint(bounds, segment.b)
  )
    return false;
  let cache = segmentContainmentCache.get(footprint);
  if (!cache) segmentContainmentCache.set(footprint, (cache = new WeakMap()));
  if (cache.has(segment)) return cache.get(segment);
  const middle = [
    (segment.a[0] + segment.b[0]) / 2,
    (segment.a[1] + segment.b[1]) / 2,
  ];
  const contained = [segment.a, middle, segment.b].every((point) =>
    containsPoint(footprint, point),
  );
  cache.set(segment, contained);
  return contained;
}

/**
 * Omit a whole, separately represented source footprint only when it has named
 * rooms of another building and none of the requested building. A shared or
 * unclassified component is kept; no invented building boundary is introduced.
 */
export function getBuildingFloorView(floor, building) {
  if (!floor || !building || !floor.footprints?.length) return floor;
  const components = buildingComponents(floor);
  const excluded = components
    .filter(({ owners }) => owners.size > 0 && !owners.has(building))
    .map(({ footprint }) => footprint);
  const footprints = indoorFootprints(floor);
  const indoorOnly = footprints !== floor.footprints;
  if (!excluded.length && !indoorOnly) return floor;
  const view = {
    ...floor,
    footprints: footprints.filter((footprint) => !excluded.includes(footprint)),
  };
  if (Array.isArray(floor.polygons))
    view.polygons = floor.polygons.filter(
      (polygon) =>
        (!indoorOnly || polygon.exteriorEligible !== false) &&
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

/**
 * Complete, source-defined isolated components belong in camera/cutaway bounds,
 * including their unnamed labs and halls. Shared components remain scoped by
 * named polygons; this does not assign room identities or create connections.
 */
export function getBuildingScopePoints(floor, building) {
  const ids = getBuildingScopePolygonIds(floor, building);
  const points = (floor?.polygons || [])
    .filter((polygon) => ids.has(polygon.id))
    .flatMap((polygon) => polygon.points || []);
  if (!floor || !building) return points;
  const components = buildingComponents(floor);
  const exclusive = components.filter(
    ({ owners }) => owners.size === 1 && owners.has(building),
  );
  for (const { footprint } of exclusive) points.push(...footprint.points);
  // A separately drawn, unassigned source island can sit within the existing
  // display margin (E1's ЛК3 is one). Keep that island whole instead of shaving
  // its corner. This is display extent only; no building identity is assigned.
  const envelopes = exclusive.map(({ footprint }) => {
    const [x, z, X, Z] = ringBounds(footprint.points);
    return [
      x - BUILDING_DISPLAY_MARGIN,
      z - BUILDING_DISPLAY_MARGIN,
      X + BUILDING_DISPLAY_MARGIN,
      Z + BUILDING_DISPLAY_MARGIN,
    ];
  });
  for (const { footprint, owners } of components)
    if (
      !owners.size &&
      envelopes.some((bounds) =>
        boundsOverlap(bounds, ringBounds(footprint.points)),
      )
    )
      points.push(...footprint.points);
  return points;
}

/** Discard only shapes wholly outside the already selected cutaway rectangle. */
export function restrictFloorDisplayBounds(floor, bounds) {
  if (!bounds) return floor;
  const intersects = (polygon) =>
    boundsOverlap(ringBounds(polygon.points), bounds);
  const segmentIntersects = ({ a, b }) =>
    !finitePoint(a) ||
    !finitePoint(b) ||
    boundsOverlap(
      [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1]),
      ],
      bounds,
    );
  const view = { ...floor };
  for (const name of ["footprints", "polygons"])
    if (Array.isArray(floor[name])) view[name] = floor[name].filter(intersects);
  for (const name of ["walls", "doors"])
    if (Array.isArray(floor[name]))
      view[name] = floor[name].filter(segmentIntersects);
  for (const name of ["markers", "transitions"])
    if (Array.isArray(floor[name]))
      view[name] = floor[name].filter((marker) =>
        boundsContainPoint(
          bounds,
          marker.position || marker.center || marker.point,
        ),
      );
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
