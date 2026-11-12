import polygonClipping from "polygon-clipping";

const BORDER_TOLERANCE = 0.05;
const MIN_SHARED_BORDER = 0.5;
const finitePoint = (point) =>
  Array.isArray(point) &&
  point.length >= 2 &&
  point.slice(0, 2).every(Number.isFinite);
const ringArea = (ring) =>
  Math.abs(
    ring.reduce((sum, a, index) => {
      const b = ring[(index + 1) % ring.length];
      return sum + a[0] * b[1] - b[0] * a[1];
    }, 0),
  ) / 2;
const validRing = (ring) =>
  Array.isArray(ring) &&
  ring.length >= 3 &&
  ring.every(finitePoint) &&
  ringArea(ring) > 1e-6;
const rings = (polygon) => [polygon.points, ...(polygon.holes || [])];
const validPolygon = (polygon) =>
  validRing(polygon?.points) &&
  (polygon.holes == null ||
    (Array.isArray(polygon.holes) && polygon.holes.every(validRing)));

/** A number is only a candidate group; it never establishes proximity/access. */
export function indexedRoomGroup(label) {
  if (typeof label !== "string") return null;
  const normalized = label
    .toUpperCase()
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/\s+/gu, "");
  const match = normalized.match(
    /^([А-ЯЁA-Z]+)-?(\d+)(?:[-.](\d+[А-ЯЁA-Z]?))?$/u,
  );
  return match
    ? { key: `${match[1]}-${match[2]}`, index: match[3] || null }
    : null;
}

function sharedBorder(a, b) {
  // Overlapping/duplicate/nested outlines are not evidence of neighbouring
  // rooms. A shared outer or hole boundary is; no doorway is inferred from it.
  const overlap = polygonClipping.intersection(rings(a), rings(b));
  const overlapArea = overlap.reduce(
    (sum, polygon) =>
      sum +
      ringArea(polygon[0]) -
      polygon.slice(1).reduce((area, hole) => area + ringArea(hole), 0),
    0,
  );
  if (overlapArea > 0.01) return 0;
  let length = 0;
  for (const ra of rings(a))
    for (let i = 0; i < ra.length; i++) {
      const p = ra[i],
        q = ra[(i + 1) % ra.length];
      const size = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (size < MIN_SHARED_BORDER) continue;
      const ux = (q[0] - p[0]) / size,
        uy = (q[1] - p[1]) / size;
      for (const rb of rings(b))
        for (let j = 0; j < rb.length; j++) {
          const r = rb[j],
            s = rb[(j + 1) % rb.length];
          const side = Math.hypot(s[0] - r[0], s[1] - r[1]);
          if (side < MIN_SHARED_BORDER) continue;
          if (Math.abs(ux * (s[1] - r[1]) - uy * (s[0] - r[0])) / side > 0.01)
            continue;
          const off = (v) => Math.abs(ux * (v[1] - p[1]) - uy * (v[0] - p[0]));
          if (off(r) > BORDER_TOLERANCE || off(s) > BORDER_TOLERANCE) continue;
          const along = (v) => ux * (v[0] - p[0]) + uy * (v[1] - p[1]);
          const lo = Math.max(0, Math.min(along(r), along(s)));
          const hi = Math.min(size, Math.max(along(r), along(s)));
          length += Math.max(0, hi - lo);
        }
    }
  return length;
}

/** Conservative plan-only adjacency for an unavailable indexed destination.
 * Returns catalogue IDs, never graph edges or an assumed inner entrance.
 */
export function indexedRoomNeighbors(graph, targetId, floor) {
  const target = graph?.rooms?.[targetId];
  const group = indexedRoomGroup(target?.label);
  if (
    !group?.index ||
    target.kind !== "room" ||
    !target.building ||
    !Number.isFinite(target.physicalLevel) ||
    graph.units !== "meters" ||
    floor?.units !== "meters" ||
    floor.id !== target.floorId ||
    floor.campusId !== graph.campusId ||
    floor.buildingLevels?.[target.building] !== target.physicalLevel ||
    !Array.isArray(floor.polygons)
  )
    return [];
  const polygons = (id) =>
    floor.polygons.filter(
      (polygon) =>
        (polygon.id === id || polygon.roomId === id) &&
        polygon.kind === "room" &&
        polygon.building === target.building &&
        validPolygon(polygon),
    );
  const targetPolygons = polygons(targetId);
  if (!targetPolygons.length) return [];
  const result = [];
  for (const [id, room] of Object.entries(graph.rooms)) {
    const other = indexedRoomGroup(room.label);
    if (
      id === targetId ||
      room.kind !== "room" ||
      room.floorId !== target.floorId ||
      room.building !== target.building ||
      room.physicalLevel !== target.physicalLevel ||
      other?.key !== group.key ||
      other.index === group.index
    )
      continue;
    let boundary = 0;
    try {
      for (const a of targetPolygons)
        for (const b of polygons(id))
          boundary = Math.max(boundary, sharedBorder(a, b));
    } catch {
      continue;
    }
    if (boundary >= MIN_SHARED_BORDER)
      result.push({
        roomId: id,
        baseRoom: other.index == null,
        sharedBoundaryMeters: boundary,
      });
  }
  return result.sort(
    (a, b) =>
      Number(b.baseRoom) - Number(a.baseRoom) ||
      b.sharedBoundaryMeters - a.sharedBoundaryMeters ||
      a.roomId.localeCompare(b.roomId),
  );
}
