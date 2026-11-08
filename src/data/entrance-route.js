import { findRoute } from "./routing.js";
import { entranceHint } from "./entrance-hints.js";

const roomKey = (room) =>
  typeof room === "string" ? room : room?.roomId || room?.id;

// A zero-length route at an already selected parent room needs no fabricated
// doorway or connector. Its only instruction is the uncharted indoor stage.
function atParentRoom(graph, parentId) {
  const room = graph.rooms[parentId];
  const node = graph.nodes.find((item) => item.id === room.nodeId);
  if (!node) return null;
  const endpoint = {
    roomId: parentId,
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
    steps: [],
    distanceMeters: graph.units === "meters" ? 0 : null,
    horizontalDistanceMeters: graph.units === "meters" ? 0 : null,
    durationMinutes: 0,
    durationModel: "Вы уже в помещении, через которое расположен вход.",
    estimated: true,
    navigationMode: "manual",
  };
}

/** An explicit, labelled route to a confirmed parent entrance. Exact routing
 * remains unchanged: the missing inner door is never invented or marked as
 * reached. Only the user-confirmed G-424 group may use this presentation.
 */
export function findNavigationRoute(graph, from, to, options = {}) {
  const exact = findRoute(graph, from, to, options);
  if (
    exact.ok ||
    graph.campusId !== "v-78" ||
    exact.reason !== "target-isolated-source-component"
  )
    return exact;
  const targetId = roomKey(to);
  const hint = entranceHint({ id: targetId });
  const target = graph.rooms[targetId];
  const parent = hint && graph.rooms[hint.viaRoomId];
  if (!parent || !target || parent.floorId !== target.floorId) return exact;
  let route = findRoute(graph, from, hint.viaRoomId, options);
  if (route.code === "same-place" && roomKey(from) === hint.viaRoomId)
    route = atParentRoom(graph, hint.viaRoomId);
  if (!route?.ok) return exact;
  const message = `${roomKey(from) === hint.viaRoomId ? `Вы в ${hint.viaLabel}` : `Войдите в ${hint.viaLabel}`}. Найдите ${target.label} внутри.`;
  return {
    ...route,
    partial: true,
    requestedDestination: {
      roomId: targetId,
      label: target.label,
      floorId: target.floorId,
    },
    lastLeg: {
      kind: "inside-parent",
      viaRoomId: hint.viaRoomId,
      viaLabel: hint.viaLabel,
      label: target.label,
      message,
      geometryAvailable: false,
    },
    steps: [
      ...route.steps.filter((step) => step.kind !== "arrive"),
      {
        kind: "manual-entry",
        text: message,
        floorId: route.end.floorId,
        position: route.end.point,
      },
    ],
    distanceStatus: "parent-entrance-only",
    durationModel: `Оценка только до входа в ${hint.viaLabel}. Путь внутри до ${target.label} не измерен.`,
  };
}
