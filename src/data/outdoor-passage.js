// The user identified this retained A → И path as outdoors on 2026-11-12.
// Coordinates, portals and graph edges stay those of the source package.
export const AI_OUTDOOR_PASSAGE = {
  id: "v-78-floor1-area-604",
  floorId: "v-78-floor1",
  svgSha256: "0bd46ad48eb9d4da130e74b4f7da51bb8ddb2eadf033c3439578f0a5286c03b9",
  graphGeometrySha256:
    "00662efaf0d44e68ba615e0e8cb2d3a77b5e8a4a6d0eafadeae0052b9084da7c",
  points: [
    [-58.419, 40.1704],
    [-57.717, 42.3384],
    [-52.587, 40.6774],
    [-54.371, 35.2894],
    [-83.901, 44.8564],
    [-86.303, 37.5554],
    [-90.02, 38.7304],
    [-86.294, 49.1754],
  ],
  openBoundaryIndices: [0, 2, 3, 4, 6, 7],
  portals: [
    {
      building: "А",
      areaId: "v-78-floor1-area-124",
      edgeId: "v-78:edge:8915",
      nodeId: "v-78:floor-1:6ng:door:66n",
      position: [-88.08615, 38.3813],
    },
    {
      building: "И",
      areaId: "v-78-floor1-area-437",
      edgeId: "v-78:edge:9143",
      nodeId: "v-78:floor-1:6ng:door:66o",
      position: [-55.22901, 41.27009],
    },
  ],
};

const samePoint = (a, b, tolerance = 0.00001) =>
  Array.isArray(a) &&
  a.length === 2 &&
  Math.hypot(a[0] - b[0], a[1] - b[1]) < tolerance;

export function confirmedAIOutdoorPassage(floor) {
  if (
    floor?.campusId !== "v-78" ||
    floor.id !== AI_OUTDOOR_PASSAGE.floorId ||
    floor.units !== "meters" ||
    floor.source?.svgSha256 !== AI_OUTDOOR_PASSAGE.svgSha256
  )
    return null;
  const matches = (floor.polygons || []).filter(
    (p) => p.id === AI_OUTDOOR_PASSAGE.id,
  );
  const p = matches[0];
  return matches.length === 1 &&
    ["unclassified", "outdoor"].includes(p.kind) &&
    !p.roomId &&
    p.points?.length === AI_OUTDOOR_PASSAGE.points.length &&
    p.points.every((point, i) =>
      samePoint(point, AI_OUTDOOR_PASSAGE.points[i]),
    ) &&
    Array.isArray(p.holes) &&
    p.holes.length === 0
    ? p
    : null;
}

const graphReferences = new WeakMap();
function validGraph(graph) {
  if (graphReferences.has(graph)) return graphReferences.get(graph);
  const valid =
    graph?.campusId === "v-78" &&
    graph.units === "meters" &&
    graph.source?.geometrySha256?.[AI_OUTDOOR_PASSAGE.floorId] ===
      AI_OUTDOOR_PASSAGE.graphGeometrySha256 &&
    AI_OUTDOOR_PASSAGE.portals.every((portal) => {
      const node = graph.nodes.find((n) => n.id === portal.nodeId);
      const edge = graph.edges.find((e) => e.id === portal.edgeId);
      return (
        node?.areaId === AI_OUTDOOR_PASSAGE.id &&
        node.floorId === AI_OUTDOOR_PASSAGE.floorId &&
        samePoint(node.position, portal.position) &&
        edge?.kind === "door" &&
        [edge.from, edge.to].includes(node.id) &&
        graph.nodes.some(
          (n) =>
            n.id === (edge.from === node.id ? edge.to : edge.from) &&
            n.areaId === portal.areaId,
        )
      );
    });
  graphReferences.set(graph, valid);
  return valid;
}

/** Add street entry/exit directions along existing route nodes, never a line. */
export function withAIOutdoorInstructions(graph, segment, existingSteps) {
  if (segment.floorId !== AI_OUTDOOR_PASSAGE.floorId || !validGraph(graph))
    return existingSteps;
  const nodes = segment.nodes || [];
  const first = nodes.findIndex((n) => n.areaId === AI_OUTDOOR_PASSAGE.id);
  if (first < 0) return existingSteps;
  let last = first;
  while (nodes[last + 1]?.areaId === AI_OUTDOOR_PASSAGE.id) last++;
  const exit = AI_OUTDOOR_PASSAGE.portals.find(
    (p) => nodes[last + 1]?.areaId === p.areaId,
  );
  const entries = [
    {
      kind: "walk",
      floorId: segment.floorId,
      position: nodes[first].position,
      text: exit
        ? `${first ? "Выйдите на улицу и идите" : "Идите по улице"} к корпусу ${exit.building}`
        : "Идите по уличному переходу между корпусами А и И",
      environment: "outdoor",
      sourceAreaId: AI_OUTDOOR_PASSAGE.id,
    },
  ];
  if (exit)
    entries.push({
      kind: "walk",
      floorId: segment.floorId,
      position: nodes[last + 1].position,
      text: `Войдите с улицы в корпус ${exit.building}`,
      environment: "indoor",
      sourceAreaId: exit.areaId,
    });
  const nodeIndex = (step) =>
    nodes.findIndex((n) => samePoint(n.position, step.position, 0.001));
  return [...existingSteps, ...entries].sort(
    (a, b) => nodeIndex(a) - nodeIndex(b),
  );
}
