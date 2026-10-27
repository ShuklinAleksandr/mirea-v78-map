import adjacency from "./hall-adjacency.json" with { type: "json" };

const EPSILON = 1e-8;
const finitePoint = (point) =>
  Array.isArray(point) &&
  point.length >= 2 &&
  point.slice(0, 2).every(Number.isFinite);
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const difference = (a, b) => [a[0] - b[0], a[1] - b[1]];

function onSegment(point, a, b) {
  const direction = difference(b, a);
  const length = Math.hypot(...direction);
  if (length <= EPSILON) return Math.hypot(...difference(point, a)) <= EPSILON;
  return (
    Math.abs(cross(direction, difference(point, a))) / length <= EPSILON &&
    point[0] >= Math.min(a[0], b[0]) - EPSILON &&
    point[0] <= Math.max(a[0], b[0]) + EPSILON &&
    point[1] >= Math.min(a[1], b[1]) - EPSILON &&
    point[1] <= Math.max(a[1], b[1]) + EPSILON
  );
}

// Boundaries alone are not a room interior. This keeps a corridor running
// beside a surveyed wall, or merely touching its corner, eligible.
function strictlyInside(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j],
      b = polygon[i];
    if (onSegment(point, a, b)) return false;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/** Test every open segment interval separated by polygon crossings.
 * Endpoints and a single global midpoint miss short or off-centre crossings.
 * Collinear edges contribute split points but do not themselves close a path.
 */
export function segmentCrossesSurveyInterior(a, b, polygon) {
  if (
    !finitePoint(a) ||
    !finitePoint(b) ||
    !Array.isArray(polygon) ||
    polygon.length < 3 ||
    !polygon.every(finitePoint)
  )
    return false;
  const direction = difference(b, a);
  const lengthSquared = direction[0] ** 2 + direction[1] ** 2;
  if (lengthSquared <= EPSILON ** 2) return false;
  const splits = [0, 1];
  const add = (value) => {
    if (value >= -EPSILON && value <= 1 + EPSILON)
      splits.push(Math.max(0, Math.min(1, value)));
  };
  for (let i = 0; i < polygon.length; i++) {
    const c = polygon[i],
      d = polygon[(i + 1) % polygon.length],
      side = difference(d, c),
      offset = difference(c, a);
    const denominator = cross(direction, side);
    if (Math.abs(denominator) > EPSILON) {
      const alongSide = cross(offset, direction) / denominator;
      if (alongSide >= -EPSILON && alongSide <= 1 + EPSILON)
        add(cross(offset, side) / denominator);
    } else if (
      Math.abs(cross(offset, direction)) / Math.sqrt(lengthSquared) <=
      EPSILON
    ) {
      for (const point of [c, d])
        add(
          ((point[0] - a[0]) * direction[0] +
            (point[1] - a[1]) * direction[1]) /
            lengthSquared,
        );
    }
  }
  splits.sort((left, right) => left - right);
  for (let i = 1; i < splits.length; i++) {
    if (splits[i] - splits[i - 1] <= EPSILON) continue;
    const t = (splits[i] + splits[i - 1]) / 2;
    const point = [a[0] + direction[0] * t, a[1] + direction[1] * t];
    if (strictlyInside(point, polygon)) return true;
  }
  return false;
}

/** Runtime restriction from the user's confirmed A2 room adjacency.
 * The archived graph is retained unchanged. No links or detours are invented;
 * the restriction applies only to this exact source geometry and floor.
 */
export function getSurveyBlockedEdges(graph) {
  const blocked = new Set();
  if (
    graph?.campusId !== adjacency.campusId ||
    graph.source?.geometrySha256?.[adjacency.floorId] !==
      adjacency.sourceGeometrySha256 ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  )
    return blocked;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    if (!edge.eligible || !["corridor", "door"].includes(edge.kind)) continue;
    const a = nodes.get(edge.from),
      b = nodes.get(edge.to);
    if (a?.floorId !== adjacency.floorId || b?.floorId !== adjacency.floorId)
      continue;
    if (
      adjacency.addedRoomRegions.some((region) =>
        segmentCrossesSurveyInterior(a.position, b.position, region.points),
      )
    )
      blocked.add(edge.id);
  }
  return blocked;
}
