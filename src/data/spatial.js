/** Geometric selection helpers in the source plan's [x, z] coordinates. */
const finitePoint = (point) =>
  Array.isArray(point) &&
  point.length >= 2 &&
  Number.isFinite(point[0]) &&
  Number.isFinite(point[1]);
const cross = (a, b, c) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function segmentDistanceSquared(point, a, b) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    length = dx * dx + dz * dz;
  const t = length
    ? Math.max(
        0,
        Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / length),
      )
    : 0;
  return (point[0] - a[0] - dx * t) ** 2 + (point[1] - a[1] - dz * t) ** 2;
}
function ringDistanceSquared(point, ring) {
  let distance = Infinity;
  for (let i = 0; i < ring.length; i++)
    distance = Math.min(
      distance,
      segmentDistanceSquared(point, ring[i], ring[(i + 1) % ring.length]),
    );
  return distance;
}
function ringLocation(point, ring) {
  if (ringDistanceSquared(point, ring) < 1e-14) return 0;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside ? 1 : -1;
}
function ringArea(ring) {
  return (
    Math.abs(
      ring.reduce((sum, a, i) => {
        const b = ring[(i + 1) % ring.length];
        return sum + a[0] * b[1] - b[0] * a[1];
      }, 0),
    ) / 2
  );
}

/**
 * Select the building whose assigned source polygon contains the click.
 * At overlapping floor footprints prefer the upper source level, then the more
 * specific polygon. Gaps and courtyards fall back to the closest polygon edge,
 * never the mean room center of a long or irregular building.
 */
export function buildingAtPoint(floors, point) {
  if (!finitePoint(point)) return null;
  const containing = [],
    nearby = [];
  for (const floor of floors || [])
    for (const polygon of floor.polygons || []) {
      if (
        !polygon.building ||
        !polygon.points ||
        polygon.points.length < 3 ||
        !polygon.points.every(finitePoint)
      )
        continue;
      const holes = (polygon.holes || []).filter(
        (hole) => hole.length >= 3 && hole.every(finitePoint),
      );
      const distance = Math.min(
        ...[polygon.points, ...holes].map((ring) =>
          ringDistanceSquared(point, ring),
        ),
      );
      const candidate = {
        building: polygon.building,
        distance,
        level: Number.isFinite(floor.level) ? floor.level : 0,
        area:
          ringArea(polygon.points) -
          holes.reduce((sum, ring) => sum + ringArea(ring), 0),
      };
      nearby.push(candidate);
      if (
        ringLocation(point, polygon.points) >= 0 &&
        !holes.some((hole) => ringLocation(point, hole) === 1)
      )
        containing.push(candidate);
    }
  if (containing.length)
    return containing.sort(
      (a, b) =>
        b.level - a.level ||
        a.area - b.area ||
        a.building.localeCompare(b.building, "ru"),
    )[0].building;
  return (
    nearby.sort(
      (a, b) =>
        a.distance - b.distance ||
        b.level - a.level ||
        a.building.localeCompare(b.building, "ru"),
    )[0]?.building || null
  );
}

/** Return a counterclockwise convex hull, without a repeated closing point. */
export function convexHull(points) {
  const unique = [
    ...new Map(
      (points || [])
        .filter(finitePoint)
        .map((p) => [`${p[0]},${p[1]}`, [p[0], p[1]]]),
    ).values(),
  ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (unique.length < 3) return unique;
  const lower = [],
    upper = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0)
      lower.pop();
    lower.push(point);
  }
  for (const point of unique.toReversed()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0)
      upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}
