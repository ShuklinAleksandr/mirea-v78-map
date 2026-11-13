import { findRoute } from "./routing.js";
import { entranceHint } from "./entrance-hints.js";
import { indexedRoomNeighbors } from "./indexed-room-neighbors.js";
import { atNeighborDoor } from "./neighbor-door-route.js";

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
function findParentNavigationRoute(graph, from, to, options, exact) {
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

/** A nearby indexed room is a wayfinding endpoint, never a repaired doorway.
 * Prefer the explicitly confirmed parent relationship; otherwise require both
 * plan adjacency and a reachable original door of a room in the same group.
 */
function findDestinationNavigationRoute(graph, from, to, options) {
  const exact = findRoute(graph, from, to, options);
  if (exact.ok || exact.code !== "no-path") return exact;
  const parentRoute = findParentNavigationRoute(
    graph,
    from,
    to,
    options,
    exact,
  );
  if (parentRoute.ok) return parentRoute;
  if (graph.campusId !== "v-78") return exact;
  const targetId = roomKey(to);
  const target = graph.rooms[targetId];
  const floor = options.floors?.find((item) => item.id === target?.floorId);
  for (const candidate of indexedRoomNeighbors(graph, targetId, floor)) {
    let route = findRoute(graph, from, candidate.roomId, options);
    if (route.code === "same-place" && roomKey(from) === candidate.roomId)
      route = atNeighborDoor(graph, candidate.roomId, options) || route;
    const doorway = route.nodes?.at(-1);
    if (
      !route.ok ||
      doorway?.kind !== "door" ||
      doorway.sourceNodeIds?.length !== 2
    )
      continue;
    const message = `Рядом с ${target.label}`;
    return {
      ...route,
      partial: true,
      requestedDestination: {
        roomId: targetId,
        label: target.label,
        floorId: target.floorId,
      },
      lastLeg: {
        kind: "nearby-room",
        viaRoomId: candidate.roomId,
        viaLabel: route.end.label,
        label: target.label,
        message,
        geometryAvailable: false,
        sharedBoundaryMeters: candidate.sharedBoundaryMeters,
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
      distanceStatus: "nearby-door-only",
    };
  }
  return exact;
}

/** The same checked neighbouring doorway can start a route from an indexed
 * room whose own exit is missing. Do not draw a connector from that room,
 * rename the real start door, or infer a passage through the shared wall.
 */
export function findNavigationRoute(graph, from, to, options = {}) {
  const exact = findDestinationNavigationRoute(graph, from, to, options);
  if (exact.ok || exact.code !== "no-path" || graph.campusId !== "v-78")
    return exact;
  const originId = roomKey(from);
  const origin = graph.rooms[originId];
  const floor = options.floors?.find((item) => item.id === origin?.floorId);
  for (const candidate of indexedRoomNeighbors(graph, originId, floor)) {
    let route = findDestinationNavigationRoute(
      graph,
      candidate.roomId,
      to,
      options,
    );
    if (route.code === "same-place" && roomKey(to) === candidate.roomId)
      route = atNeighborDoor(graph, candidate.roomId, options) || route;
    if (
      route.ok &&
      route.lastLeg?.kind === "inside-parent" &&
      route.start.roomId === candidate.roomId &&
      route.end.roomId === candidate.roomId &&
      route.edges.length === 0
    ) {
      const waypoint = atNeighborDoor(graph, candidate.roomId, options);
      if (waypoint) {
        const text = `Войдите в ${route.end.label}. Найдите ${route.requestedDestination.label} внутри.`;
        route = {
          ...waypoint,
          partial: true,
          requestedDestination: route.requestedDestination,
          lastLeg: { ...route.lastLeg, message: text },
          steps: [
            ...waypoint.steps,
            {
              kind: "manual-entry",
              text,
              floorId: waypoint.end.floorId,
              position: waypoint.end.point,
            },
          ],
          distanceStatus: "parent-entrance-only",
        };
      }
    }
    const doorway = route.nodes?.[0];
    if (
      !route.ok ||
      doorway?.kind !== "door" ||
      doorway.sourceNodeIds?.length !== 2
    )
      continue;
    const message = `Начните у входа в ${route.start.label}`;
    return {
      ...route,
      partial: true,
      requestedOrigin: {
        roomId: originId,
        label: origin.label,
        floorId: origin.floorId,
      },
      firstLeg: {
        kind: "nearby-room",
        viaRoomId: candidate.roomId,
        viaLabel: route.start.label,
        label: origin.label,
        message,
        geometryAvailable: false,
        sharedBoundaryMeters: candidate.sharedBoundaryMeters,
      },
      steps: route.steps.map((step, index) =>
        index === 0 && step.kind === "start"
          ? { ...step, text: message }
          : step,
      ),
      originStatus: "nearby-door-only",
    };
  }
  return exact;
}
