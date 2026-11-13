import { getSurveyBlockedEdges } from "./survey-routing.js";
import { getStairPartitionBlockedEdges } from "./stair-partition-routing.js";

const publicKinds = new Set(["entrance", "circulation", "corridor", "hall"]);

/** A shared neighbouring room can be both endpoints' waypoint. Show its
 * original public doorway, not a fabricated line through either room wall.
 * Only bidirectional source doors reachable inside that room are accepted.
 */
export function atNeighborDoor(graph, roomId, options = {}) {
  const room = graph.rooms?.[roomId];
  if (!room || options.accessible || options.withoutStairs) return null;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const anchor = nodes.get(room.nodeId);
  if (!anchor || anchor.areaId !== roomId) return null;
  const blocked = new Set([
    ...getSurveyBlockedEdges(graph),
    ...getStairPartitionBlockedEdges(graph),
    ...(options.blockedEdgeIds || []),
  ]);
  const own = new Map(
    graph.nodes
      .filter((node) => node.areaId === roomId)
      .map((node) => [node.id, []]),
  );
  const doors = [];
  for (const edge of graph.edges) {
    if (
      !edge.eligible ||
      !edge.bidirectional ||
      !Number.isFinite(edge.cost) ||
      edge.cost < 0 ||
      blocked.has(edge.id)
    )
      continue;
    const a = nodes.get(edge.from),
      b = nodes.get(edge.to);
    if (!a || !b || a.floorId !== room.floorId || b.floorId !== room.floorId)
      continue;
    const insideA = a.areaId === roomId,
      insideB = b.areaId === roomId;
    if (insideA && insideB) {
      own.get(a.id).push(b.id);
      own.get(b.id).push(a.id);
    } else if (edge.kind === "door" && insideA !== insideB) {
      const inside = insideA ? a : b,
        outside = insideA ? b : a;
      const externalRoom = graph.rooms[outside.areaId];
      if (externalRoom && !publicKinds.has(externalRoom.kind)) continue;
      if (![...inside.position, ...outside.position].every(Number.isFinite))
        continue;
      doors.push({ inside, outside, edge });
    }
  }
  const visited = new Set([anchor.id]),
    pending = [anchor.id];
  while (pending.length)
    for (const id of own.get(pending.pop()) || [])
      if (!visited.has(id)) {
        visited.add(id);
        pending.push(id);
      }
  const door = doors
    .filter(({ inside }) => visited.has(inside.id))
    .sort((a, b) => a.edge.id.localeCompare(b.edge.id))[0];
  if (!door) return null;
  const { inside, outside, edge } = door;
  const node = {
    ...inside,
    id: `doorway:${inside.id}:${outside.id}`,
    position: inside.position.map(
      (value, index) => (value + outside.position[index]) / 2,
    ),
    roomId,
    kind: "door",
    sourceNodeIds: [inside.id, outside.id],
    sourceDoorEdgeId: edge.id,
  };
  const endpoint = {
    roomId,
    label: room.label,
    floorId: node.floorId,
    point: node.position,
    endpointKind: "place",
  };
  return {
    ok: true,
    campusId: graph.campusId,
    start: { ...endpoint },
    end: { ...endpoint },
    nodes: [node],
    graphNodes: [node],
    edges: [],
    segments: [
      { floorId: node.floorId, nodes: [node], points: [node.position] },
    ],
    transitions: [],
    steps: [
      {
        kind: "start",
        text: `Начните у входа в ${room.label}`,
        floorId: node.floorId,
        position: node.position,
      },
    ],
    distanceMeters: null,
    horizontalDistanceMeters: null,
    durationMinutes: null,
    durationModel:
      "Показан вход в соседнее помещение. Участок до выбранного помещения не измерен.",
    distanceStatus: "shared-neighbor-door-only",
    estimated: true,
    navigationMode: "manual",
    sharedNeighborDoor: true,
  };
}
