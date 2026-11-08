import { Box3, ShapeUtils, Vector2, Vector3 } from "three";

const repairs = new WeakMap();
const maxSpan = 0.24;
const maxHeightVariation = 0.045;
const fragmentClearance = 0.25;

function isolatedFragments(positions, indices, roots) {
  const groups = new Map();
  for (let face = 0; face < roots.length; face++) {
    const root = roots[face];
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(face);
  }
  const principal = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  if (groups.size < 2 || principal.length < roots.length * 0.95)
    return new Set();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const normal = new Vector3();
  function loadFace(face) {
    a.fromArray(positions, indices[face * 3] * 3);
    b.fromArray(positions, indices[face * 3 + 1] * 3);
    c.fromArray(positions, indices[face * 3 + 2] * 3);
  }
  // Distance to the main face boxes is a conservative lower bound on the
  // distance to its surface. A sparse wall triangle still protects fragments
  // next to its interior, even when its vertices are further away.
  const boxes = principal.map((face) => {
    loadFace(face);
    return new Box3().expandByPoint(a).expandByPoint(b).expandByPoint(c);
  });
  const debris = new Set();
  for (const group of groups.values()) {
    if (group === principal) continue;
    const limits = new Box3();
    const ids = new Set();
    let treadArea = 0;
    for (const face of group) {
      loadFace(face);
      limits.expandByPoint(a).expandByPoint(b).expandByPoint(c);
      normal.crossVectors(b.sub(a), c.sub(a));
      if (normal.z > 0.8 * normal.length()) treadArea += normal.z / 2;
      for (let i = 0; i < 3; i++) ids.add(indices[face * 3 + i]);
    }
    if (treadArea > 0.02) continue;
    limits.expandByScalar(fragmentClearance);
    const nearby = boxes.filter((box) => box.intersectsBox(limits));
    const attached = [...ids].some((id) => {
      a.fromArray(positions, id * 3);
      return nearby.some((box) => box.distanceToPoint(a) < fragmentClearance);
    });
    if (!attached) for (const face of group) debris.add(face);
  }
  return debris;
}

/** Find pinholes enclosed by observed tread faces in the source Z-up mesh.
 * The patch reuses boundary vertices. Open or branched scan edges, doorways,
 * and larger openings are left as surveyed. No patch enters the floor cutout.
 */
export function stairScanDisplayTopology(source) {
  if (repairs.has(source)) return repairs.get(source);
  const { positions, indices } = source;
  const vertexCount = positions.length / 3;
  const edges = new Map();
  const roots = Int32Array.from({ length: indices.length / 3 }, (_, i) => i);
  function rootOf(face) {
    while (roots[face] !== face) {
      roots[face] = roots[roots[face]];
      face = roots[face];
    }
    return face;
  }
  function addEdge(a, b, opposite, face) {
    const key = Math.min(a, b) * vertexCount + Math.max(a, b);
    const edge = edges.get(key);
    if (edge) {
      roots[rootOf(face)] = rootOf(edge[3]);
      edge[4]++;
    } else edges.set(key, [a, b, opposite, face, 1]);
  }
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    const face = i / 3;
    addEdge(a, b, c, face);
    addEdge(b, c, a, face);
    addEdge(c, a, b, face);
  }
  const debris = isolatedFragments(
    positions,
    indices,
    roots.map((_, i) => rootOf(i)),
  );
  const boundary = new Map();
  for (const edge of edges.values()) {
    if (edge[4] !== 1 || debris.has(edge[3])) continue;
    for (const vertex of edge.slice(0, 2)) {
      if (!boundary.has(vertex)) boundary.set(vertex, []);
      boundary.get(vertex).push(edge);
    }
  }
  const seen = new Set();
  const patchIndices = [];
  const origin = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();
  let holes = 0;
  for (const start of boundary.keys()) {
    let vertex = start;
    const loop = [];
    while (!seen.has(vertex)) {
      seen.add(vertex);
      const incident = boundary.get(vertex);
      if (incident.length !== 2) break;
      const outgoing = incident.find(([a]) => a === vertex);
      if (!outgoing || !incident.some(([, b]) => b === vertex)) break;
      loop.push(outgoing);
      vertex = outgoing[1];
    }
    if (vertex !== start || loop.length < 3 || loop.length > 24) continue;
    const ids = loop.map(([a]) => a);
    const contour = ids.map(
      (a) => new Vector2(...positions.slice(a * 3, a * 3 + 2)),
    );
    const heights = ids.map((a) => positions[a * 3 + 2]);
    const area = ShapeUtils.area(contour);
    // Only the clockwise interior boundary of an up-facing surface qualifies.
    if (
      area > -0.00015 ||
      area < -0.025 ||
      Math.max(...contour.map((p) => p.x)) -
        Math.min(...contour.map((p) => p.x)) >
        maxSpan ||
      Math.max(...contour.map((p) => p.y)) -
        Math.min(...contour.map((p) => p.y)) >
        maxSpan ||
      Math.max(...heights) - Math.min(...heights) > maxHeightVariation
    )
      continue;

    const support = loop.map(([a, b, opposite]) => {
      origin.fromArray(positions, a * 3);
      ab.fromArray(positions, b * 3).sub(origin);
      ac.fromArray(positions, opposite * 3).sub(origin);
      return ab.cross(ac).normalize().z;
    });
    if (
      support.some((normal) => normal < -0.2) ||
      support.filter((normal) => normal > 0.75).length / loop.length < 0.65
    )
      continue;
    const triangles = ShapeUtils.triangulateShape(contour, []);
    if (triangles.length !== loop.length - 2) continue;
    for (const [a, b, c] of triangles) {
      const normalZ =
        (contour[b].x - contour[a].x) * (contour[c].y - contour[a].y) -
        (contour[b].y - contour[a].y) * (contour[c].x - contour[a].x);
      patchIndices.push(
        ids[a],
        ...(normalZ > 0 ? [ids[b], ids[c]] : [ids[c], ids[b]]),
      );
    }
    holes++;
  }
  const result = {
    observedIndices: debris.size
      ? indices.filter((_, i) => !debris.has(Math.floor(i / 3)))
      : indices,
    patchIndices,
    holes,
    isolatedTriangles: debris.size,
  };
  repairs.set(source, result);
  return result;
}
