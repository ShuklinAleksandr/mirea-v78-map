import polygonClipping from "polygon-clipping";

const ROAD_DISTANCE = 20;
const EPSILON = 1e-7;
const cachedRoads = new WeakMap();
const finitePoint = (point) =>
  Array.isArray(point) &&
  Number.isFinite(point[0]) &&
  Number.isFinite(point[1]);

function edge(a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  if (length <= EPSILON) return null;
  return { a, b, x: dx / length, z: dz / length, length };
}

// Restrict a distance interval by a linear coordinate on the road segment.
function clipInterval(interval, origin, slope, low, high) {
  if (Math.abs(slope) <= EPSILON)
    return origin >= low && origin <= high ? interval : null;
  const from = (low - origin) / slope;
  const to = (high - origin) / slope;
  const start = Math.max(interval[0], Math.min(from, to));
  const end = Math.min(interval[1], Math.max(from, to));
  return end - start > EPSILON ? [start, end] : null;
}

function nearbyIntervals(road, boundaries, radius) {
  const intervals = [];
  const x0 = Math.min(road.a[0], road.b[0]) - radius;
  const x1 = Math.max(road.a[0], road.b[0]) + radius;
  const z0 = Math.min(road.a[1], road.b[1]) - radius;
  const z1 = Math.max(road.a[1], road.b[1]) + radius;

  for (const wall of boundaries) {
    const [ax, az] = wall.a;
    const [bx, bz] = wall.b;
    if (
      Math.max(ax, bx) < x0 ||
      Math.min(ax, bx) > x1 ||
      Math.max(az, bz) < z0 ||
      Math.min(az, bz) > z1
    )
      continue;
    const dx = road.a[0] - ax;
    const dz = road.a[1] - az;

    // Points near the middle of an edge lie inside a rectangular strip.
    const along = clipInterval(
      [0, road.length],
      dx * wall.x + dz * wall.z,
      road.x * wall.x + road.z * wall.z,
      0,
      wall.length,
    );
    const across =
      along &&
      clipInterval(
        along,
        -dx * wall.z + dz * wall.x,
        -road.x * wall.z + road.z * wall.x,
        -radius,
        radius,
      );
    if (across) intervals.push(across);

    // Each closed outline vertex is the start of an edge and adds a round cap.
    const cross = -dx * road.z + dz * road.x;
    if (Math.abs(cross) < radius) {
      const center = -dx * road.x - dz * road.z;
      const half = Math.sqrt(radius * radius - cross * cross);
      const start = Math.max(0, center - half);
      const end = Math.min(road.length, center + half);
      if (end - start > EPSILON) intervals.push([start, end]);
    }
  }

  intervals.sort((a, b) => a[0] - b[0]);
  const combined = [];
  for (const interval of intervals) {
    const previous = combined.at(-1);
    if (previous && interval[0] <= previous[1] + EPSILON)
      previous[1] = Math.max(previous[1], interval[1]);
    else combined.push(interval);
  }
  return combined;
}

function roadSurface(road, start, end, halfWidth) {
  const [x, z] = road.a;
  const startX = x + start * road.x;
  const startZ = z + start * road.z;
  const endX = x + end * road.x;
  const endZ = z + end * road.z;
  const angle = Math.atan2(road.z, road.x);
  const ring = [];
  for (let i = 0; i <= 4; i++) {
    const cap = angle - Math.PI / 2 + (i * Math.PI) / 4;
    ring.push([
      endX + Math.cos(cap) * halfWidth,
      endZ + Math.sin(cap) * halfWidth,
    ]);
  }
  for (let i = 0; i <= 4; i++) {
    const cap = angle + Math.PI / 2 + (i * Math.PI) / 4;
    ring.push([
      startX + Math.cos(cap) * halfWidth,
      startZ + Math.sin(cap) * halfWidth,
    ]);
  }
  return [ring];
}

/** The known access roads form one flat surface around mapped buildings. */
export function nearbyRoadPolygons(roads, footprints, excludedFootprint) {
  if (!roads?.length || !footprints?.length) return [];
  let byRoads = cachedRoads.get(footprints);
  if (!byRoads) cachedRoads.set(footprints, (byRoads = new WeakMap()));
  const cached = byRoads.get(roads);
  if (cached && cached.excludedFootprint === excludedFootprint)
    return cached.polygons;

  const buildings = footprints.map((p) => [p.points, ...(p.holes || [])]);
  const boundaries = buildings.flatMap((rings, index) =>
    footprints[index] === excludedFootprint
      ? []
      : rings.flatMap((ring) =>
          ring
            .map((point, i) => edge(point, ring[(i + 1) % ring.length]))
            .filter(Boolean),
        ),
  );
  const surfaces = [];
  for (const road of roads) {
    if (road?.kind !== "service" || !Array.isArray(road.points)) continue;
    const width =
      Number.isFinite(road.width) && road.width > 0 ? road.width : 3;
    const half = width / 2;
    // Reserve the road half width so the edges also stay within 20 metres.
    const distance = ROAD_DISTANCE - half;
    if (distance <= 0) continue;
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1];
      const b = road.points[i];
      if (!finitePoint(a) || !finitePoint(b)) continue;
      const segment = edge(a, b);
      if (!segment) continue;
      for (const [start, end] of nearbyIntervals(segment, boundaries, distance))
        surfaces.push(roadSurface(segment, start, end, half));
    }
  }
  // Difference also unions overlapping road strips in its subject MultiPolygon.
  const visible = surfaces.length
    ? polygonClipping
        .difference(surfaces, buildings)
        .map(([points, ...holes]) => ({
          points: points.slice(0, -1),
          holes: holes.map((ring) => ring.slice(0, -1)),
        }))
    : [];
  byRoads.set(roads, { excludedFootprint, polygons: visible });
  return visible;
}
