import { getBuildingFloorComponentScopes } from "../map/building-view.js";
import {
  ROUTE_TRACKING_MAX_ACCURACY_METERS,
  ROUTE_TRACKING_MAX_AGE_MS,
} from "./route-tracking.js";
import { isCurrentUserLocation } from "./user-location.js";

const CACHE_LIMIT = 8;
const cache = new Map();
const EPSILON = 1e-7;
const finitePoint = (point) =>
  Array.isArray(point) &&
  point.length >= 2 &&
  Number.isFinite(point[0]) &&
  Number.isFinite(point[1]);

function segmentDistanceSquared(point, a, b) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1];
  const length = dx * dx + dz * dz;
  const t = length
    ? Math.max(
        0,
        Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / length),
      )
    : 0;
  return (point[0] - a[0] - dx * t) ** 2 + (point[1] - a[1] - dz * t) ** 2;
}

function ringInside(point, ring, clearance) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j],
      b = ring[i];
    if (segmentDistanceSquared(point, a, b) <= clearance ** 2) return false;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

function preparePolygon(polygon) {
  const rings = [polygon?.points, ...(polygon?.holes || [])];
  if (
    !rings.every(
      (ring) =>
        Array.isArray(ring) && ring.length >= 3 && ring.every(finitePoint),
    )
  )
    return null;
  const outer = rings[0];
  return {
    rings,
    bounds: [
      Math.min(...outer.map((p) => p[0])),
      Math.min(...outer.map((p) => p[1])),
      Math.max(...outer.map((p) => p[0])),
      Math.max(...outer.map((p) => p[1])),
    ],
  };
}

function contains(shape, point, clearance) {
  const [x, z, X, Z] = shape.bounds;
  if (
    point[0] <= x + clearance ||
    point[0] >= X - clearance ||
    point[1] <= z + clearance ||
    point[1] >= Z - clearance
  )
    return false;
  if (!ringInside(point, shape.rings[0], clearance)) return false;
  for (const hole of shape.rings.slice(1)) {
    if (ringInside(point, hole, 0)) return false;
    for (let i = 0; i < hole.length; i++)
      if (
        segmentDistanceSquared(point, hole[i], hole[(i + 1) % hole.length]) <=
        clearance ** 2
      )
        return false;
  }
  return true;
}

function intersects(shape, point, radius) {
  const [x, z, X, Z] = shape.bounds;
  if (
    point[0] < x - radius ||
    point[0] > X + radius ||
    point[1] < z - radius ||
    point[1] > Z + radius
  )
    return false;
  if (contains(shape, point, 0)) return true;
  return shape.rings.some((ring) =>
    ring.some(
      (a, i) =>
        segmentDistanceSquared(point, a, ring[(i + 1) % ring.length]) <=
        radius ** 2,
    ),
  );
}

function indexFor(floor) {
  const levelsKey = JSON.stringify(floor.buildingLevels || {});
  const previous = cache.get(floor);
  if (
    previous &&
    previous.levelsKey === levelsKey &&
    previous.polygons === floor.polygons &&
    previous.footprints === floor.footprints &&
    previous.exteriorFootprints === floor.exteriorFootprints
  ) {
    cache.delete(floor);
    cache.set(floor, previous);
    return previous;
  }
  const shapes = [],
    indoor = [];
  for (const polygon of floor.polygons || []) {
    if (
      !polygon.building ||
      polygon.kind === "outdoor" ||
      polygon.exteriorEligible === false ||
      !Number.isFinite(floor.buildingLevels?.[polygon.building])
    )
      continue;
    const shape = preparePolygon(polygon);
    if (shape) shapes.push({ ...shape, building: polygon.building });
  }
  const outlines = floor.exteriorFootprints?.length
    ? floor.exteriorFootprints
    : floor.footprints || [];
  for (const polygon of outlines) {
    const shape = preparePolygon(polygon);
    if (shape) indoor.push(shape);
  }
  // Only indoor components with exactly one known owner can establish context
  // in an unnamed corridor. Shared display scopes never establish ownership.
  if (floor.exteriorFootprints?.length) {
    const scopeFloor = { ...floor };
    for (const [building, level] of Object.entries(
      floor.buildingLevels || {},
    )) {
      if (!Number.isFinite(level)) continue;
      for (const scope of getBuildingFloorComponentScopes(
        scopeFloor,
        building,
      )) {
        if (!scope.exclusive) continue;
        const shape = preparePolygon(scope.footprint);
        if (shape) shapes.push({ ...shape, building });
      }
    }
  }
  const index = {
    shapes,
    indoor,
    hasOutlines: outlines.length > 0,
    levelsKey,
    polygons: floor.polygons,
    footprints: floor.footprints,
    exteriorFootprints: floor.exteriorFootprints,
  };
  cache.delete(floor);
  cache.set(floor, index);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return index;
}

/**
 * Context of a point on an already selected plan, never GPS floor detection.
 * margin and accuracy are radii in plan units (V78 uses metres). The entire
 * uncertainty disc must fit inside one unambiguous source area. null means
 * keep the current context: no nearest-room or rectangle fallback is used.
 * Source geometry is immutable; eight recent per-view CPU indexes are retained.
 */
export function resolveFloorContext(
  floor,
  point,
  { margin = 0.35, accuracy = 0, acrossRooms = false } = {},
) {
  if (
    !floor ||
    !finitePoint(point) ||
    !Number.isFinite(margin) ||
    margin < 0 ||
    !Number.isFinite(accuracy) ||
    accuracy < 0
  )
    return null;
  const clearance = Math.max(EPSILON, margin + accuracy);
  const index = indexFor(floor);
  if (
    index.hasOutlines &&
    !index.indoor.some((shape) => contains(shape, point, clearance))
  )
    return null;
  let building = null;
  const ownedClearance = acrossRooms ? Math.max(EPSILON, margin) : clearance;
  for (const shape of index.shapes) {
    if (!contains(shape, point, ownedClearance)) continue;
    if (building && building !== shape.building) return null;
    building = shape.building;
  }
  if (
    building &&
    index.shapes.some(
      (shape) =>
        shape.building !== building && intersects(shape, point, clearance),
    )
  )
    return null;
  return building
    ? { building, physicalLevel: floor.buildingLevels[building] }
    : null;
}

/** Interpret a reliable horizontal GPS fix on the current plan. Its accuracy
 * can span rooms of one wing, but not another building or an outside edge. */
export function resolveGpsFloorContext(floor, location, now = Date.now()) {
  if (
    !floor?.id ||
    floor.units !== "meters" ||
    location?.source !== "gps" ||
    !isCurrentUserLocation(location, now) ||
    (location.status && location.status !== "inside") ||
    (location.floorId && location.floorId !== floor.id) ||
    (floor.campusId && location.campusId !== floor.campusId) ||
    location.timestamp > now + 2_000 ||
    now - location.timestamp > ROUTE_TRACKING_MAX_AGE_MS ||
    !Number.isFinite(location.accuracyMeters) ||
    location.accuracyMeters <= 0 ||
    location.accuracyMeters > ROUTE_TRACKING_MAX_ACCURACY_METERS
  )
    return null;
  return resolveFloorContext(floor, location.point, {
    accuracy: location.accuracyRadiusMap ?? location.accuracyMeters,
    acrossRooms: true,
  });
}

/** Resolve only a sample lying on an existing route edge, not nearby rooms. */
export function resolveRouteFloorContext(floor, point, nodes) {
  if (
    !floor?.id ||
    floor.units !== "meters" ||
    !finitePoint(point) ||
    !Array.isArray(nodes)
  )
    return null;
  let building = null;
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1],
      b = nodes[i];
    if (!finitePoint(a?.position) || !finitePoint(b?.position)) return null;
    if (segmentDistanceSquared(point, a.position, b.position) > 0.25 ** 2)
      continue;
    const level = floor.buildingLevels?.[a.building];
    if (
      a.floorId !== floor.id ||
      b.floorId !== floor.id ||
      !a.building ||
      a.building !== b.building ||
      !Number.isFinite(level) ||
      a.physicalLevel !== level ||
      b.physicalLevel !== level
    )
      return null;
    if (
      Math.hypot(
        a.position[0] - b.position[0],
        a.position[1] - b.position[1],
      ) <= EPSILON
    )
      continue;
    if (building && building !== a.building) return null;
    building = a.building;
  }
  return building
    ? { building, physicalLevel: floor.buildingLevels[building] }
    : null;
}
