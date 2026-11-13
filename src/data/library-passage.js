import reference from "./library-passage-reference.json" with { type: "json" };

export const LIBRARY_I_PASSAGE = reference;
export const LIBRARY_PASSAGE_EDGE_ID = `${reference.id}:crossing`;
const EPS = 1e-7;
const samePoint = (a, b) =>
  Array.isArray(a) &&
  a.length === 2 &&
  a.every(Number.isFinite) &&
  Math.hypot(a[0] - b[0], a[1] - b[1]) < EPS;
const sameSegment = (a, b) =>
  (samePoint(a.a, b.a) && samePoint(a.b, b.b)) ||
  (samePoint(a.a, b.b) && samePoint(a.b, b.a));
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const delta = (a, b) => [a[0] - b[0], a[1] - b[1]];
function onSegment(point, a, b) {
  const direction = delta(b, a),
    offset = delta(point, a);
  const length = Math.hypot(...direction);
  return (
    Math.abs(cross(direction, offset)) <= EPS * Math.max(1, length) &&
    point[0] >= Math.min(a[0], b[0]) - EPS &&
    point[0] <= Math.max(a[0], b[0]) + EPS &&
    point[1] >= Math.min(a[1], b[1]) - EPS &&
    point[1] <= Math.max(a[1], b[1]) + EPS
  );
}
function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j],
      b = ring[i];
    if (onSegment(point, a, b)) return true;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/** Check endpoints and every open interval between boundary intersections.
 * A midpoint-only check could miss a thin room, notch or hole along a link. */
export function libraryPassageSegmentCovered(a, b, area) {
  if (
    ![a, b].every(
      (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite),
    )
  )
    return false;
  const inside = (p) =>
    inRing(p, area.points) &&
    !(area.holes || []).some((hole) => inRing(p, hole));
  if (!inside(a) || !inside(b)) return false;
  const direction = delta(b, a),
    length2 = direction[0] ** 2 + direction[1] ** 2;
  if (length2 < EPS ** 2) return true;
  const splits = [0, 1];
  for (const ring of [area.points, ...(area.holes || [])]) {
    for (let i = 0; i < ring.length; i++) {
      const c = ring[i],
        d = ring[(i + 1) % ring.length];
      const side = delta(d, c),
        offset = delta(c, a),
        denominator = cross(direction, side);
      if (Math.abs(denominator) > EPS) {
        const t = cross(offset, side) / denominator,
          u = cross(offset, direction) / denominator;
        if (t > 0 && t < 1 && u >= -EPS && u <= 1 + EPS) splits.push(t);
      } else if (Math.abs(cross(offset, direction)) <= EPS) {
        for (const p of [c, d]) {
          const v = delta(p, a),
            t = (v[0] * direction[0] + v[1] * direction[1]) / length2;
          if (t > 0 && t < 1) splits.push(t);
        }
      }
    }
  }
  splits.sort((a, b) => a - b);
  for (let i = 1; i < splits.length; i++) {
    const t = (splits[i - 1] + splits[i]) / 2;
    if (!inside(a.map((n, k) => n + t * direction[k]))) return false;
  }
  return true;
}

const floorViews = new WeakMap();
export function withLibraryPassageFloor(floor) {
  if (!floor || floor.userConfirmedLibraryPassage?.id === reference.id)
    return floor;
  if (floorViews.has(floor)) return floorViews.get(floor);
  let view = floor;
  if (
    floor.id === reference.floorId &&
    floor.campusId === reference.campusId &&
    floor.units === "meters" &&
    floor.source?.svgSha256 === reference.sourceSvgSha256 &&
    reference.areas.every((expected) => {
      const matches = floor.polygons?.filter((p) => p.id === expected.id);
      const p = matches?.[0];
      return (
        matches?.length === 1 &&
        p.kind === expected.kind &&
        p.sourceGeometry === expected.sourceGeometry &&
        samePoint(p.center, expected.center) &&
        p.holes?.length === 0 &&
        p.points?.length === expected.points.length &&
        p.points.every((q, i) => samePoint(q, expected.points[i]))
      );
    }) &&
    [reference.boundary, reference.closedMark].every(
      (segment) =>
        floor.walls?.filter((w) => sameSegment(w, segment)).length === 1,
    )
  ) {
    view = {
      ...floor,
      walls: floor.walls.filter(
        (w) =>
          ![reference.boundary, reference.closedMark].some((segment) =>
            sameSegment(w, segment),
          ),
      ),
      userConfirmedLibraryPassage: {
        id: reference.id,
        evidence: reference.evidence,
        removedWallCount: 2,
      },
    };
  }
  floorViews.set(floor, view);
  return view;
}

/** The former closed end is an open corridor boundary, not a room doorway.
 * Allow only the two guarded source areas to meet through this exact span.
 * Other walls, doors, holes and stair cutouts are still checked by callers. */
export function isConfirmedLibraryPassageConnector(floor, a, b) {
  const corrected = withLibraryPassageFloor(floor);
  if (corrected?.userConfirmedLibraryPassage?.id !== reference.id) return false;
  if (
    ![a, b].every(
      (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite),
    )
  )
    return false;
  const wall = reference.boundary;
  const direction = delta(b, a),
    side = delta(wall.b, wall.a);
  const denominator = cross(direction, side);
  let crossing;
  if (Math.abs(denominator) <= EPS) {
    // A point or a short segment lying exactly on the removed wall is also
    // inside this confirmed opening; this is not an ambiguous room overlap.
    if (!onSegment(a, wall.a, wall.b) || !onSegment(b, wall.a, wall.b))
      return false;
    return true;
  }
  const offset = delta(wall.a, a);
  const t = cross(offset, side) / denominator,
    u = cross(offset, direction) / denominator;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return false;
  crossing = a.map((n, i) => n + t * direction[i]);
  return [reference.areas, [...reference.areas].reverse()].some(
    ([first, second]) =>
      libraryPassageSegmentCovered(a, crossing, first) &&
      libraryPassageSegmentCovered(crossing, b, second),
  );
}

function passageGeometry() {
  const { a, b } = reference.boundary,
    direction = delta(b, a);
  const length = Math.hypot(...direction),
    along = direction.map((n) => n / length);
  const normal = [-along[1], along[0]];
  const markMiddle = reference.closedMark.a.map(
    (n, i) => (n + reference.closedMark.b[i]) / 2,
  );
  const t =
    (markMiddle[0] - a[0]) * along[0] + (markMiddle[1] - a[1]) * along[1];
  const center = a.map((n, i) => n + t * along[i]);
  // Only this short, user-confirmed opening crosses the former wall.
  const portals = [-0.12, 0.12].map((offset) =>
    center.map((n, i) => n + offset * normal[i]),
  );
  if (
    !reference.areas.every(
      (area, i) =>
        libraryPassageSegmentCovered(
          reference.anchors[i].position,
          portals[i],
          area,
        ) && libraryPassageSegmentCovered(portals[i], center, area),
    )
  )
    return null;
  return { center, portals };
}

const graphViews = new WeakMap();
/** A local, explicitly user-confirmed overlay. Archived nodes/edges stay intact;
 * only two contained approach links and a 24 cm boundary crossing are added. */
export function withLibraryPassageGraph(graph) {
  if (!graph || graph.userConfirmedLibraryPassage?.id === reference.id)
    return graph;
  if (graphViews.has(graph)) return graphViews.get(graph);
  let view = graph;
  const geometry = passageGeometry();
  if (
    geometry &&
    graph.campusId === reference.campusId &&
    graph.units === "meters" &&
    graph.source?.sha256 === reference.sourceGraphSha256 &&
    graph.source?.geometrySha256?.[reference.floorId] ===
      reference.sourceGeometrySha256 &&
    Array.isArray(graph.nodes) &&
    Array.isArray(graph.edges) &&
    !graph.nodes.some((n) => n.id.startsWith(`${reference.id}:`)) &&
    !graph.edges.some((e) => e.id.startsWith(`${reference.id}:`)) &&
    reference.anchors.every((expected) => {
      const matches = graph.nodes.filter((n) => n.id === expected.id),
        n = matches[0];
      return (
        matches.length === 1 &&
        n.floorId === reference.floorId &&
        n.areaId === expected.areaId &&
        n.kind === "waypoint" &&
        !n.roomId &&
        samePoint(n.position, expected.position) &&
        graph.edges.some(
          (e) =>
            e.eligible &&
            e.kind === "corridor" &&
            [e.from, e.to].includes(n.id),
        )
      );
    }) &&
    reference.sourceDoors.every((expected) => {
      const matches = graph.edges.filter((e) => e.id === expected.id),
        e = matches[0];
      return (
        matches.length === 1 &&
        e.eligible &&
        e.kind === "door" &&
        e.sourceId === expected.sourceId &&
        e.from === expected.from &&
        e.to === expected.to &&
        e.bidirectional === expected.bidirectional
      );
    })
  ) {
    const portals = geometry.portals.map((position, i) => ({
      id: `${reference.id}:portal:${i}`,
      floorId: reference.floorId,
      areaId: reference.areas[i].id,
      roomId: null,
      kind: "passage",
      building: i ? "И" : null,
      physicalLevel: i ? 1 : null,
      sourceLevel: 1,
      position,
      source: "user-confirmed-library-passage",
      confidence: "user-confirmed",
      evidence: reference.evidence,
      ephemeral: true,
    }));
    const link = (id, a, b, kind, areaId) => {
      const length = Math.hypot(
        a.position[0] - b.position[0],
        a.position[1] - b.position[1],
      );
      return {
        id: `${reference.id}:${id}`,
        from: a.id,
        to: b.id,
        kind,
        bidirectional: true,
        distanceMeters: length,
        cost: length,
        eligible: true,
        ephemeral: true,
        source: "user-confirmed-library-passage",
        confidence: "user-confirmed",
        evidence: reference.evidence,
        ...(areaId ? { areaId } : {}),
        distanceStatus: "source-plan-local-estimate",
      };
    };
    const edges = [
      link(
        "approach:0",
        reference.anchors[0],
        portals[0],
        "corridor",
        reference.areas[0].id,
      ),
      link("crossing", portals[0], portals[1], "passage"),
      link(
        "approach:1",
        portals[1],
        reference.anchors[1],
        "corridor",
        reference.areas[1].id,
      ),
    ];
    view = {
      ...graph,
      nodes: [...graph.nodes, ...portals],
      edges: [...graph.edges, ...edges],
      userConfirmedLibraryPassage: {
        id: reference.id,
        evidence: reference.evidence,
        center: geometry.center,
        nodeIds: portals.map((n) => n.id),
        edgeIds: edges.map((e) => e.id),
      },
    };
  }
  graphViews.set(graph, view);
  return view;
}
