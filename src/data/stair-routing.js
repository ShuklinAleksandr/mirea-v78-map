import registry from "../../public/data/stair-layouts.json" with { type: "json" };

import { entranceStairPortals } from "./entrance-stair-portals.js";
import { photographedStairCounterparts } from "./stair-counterparts.js";
import { iMainStairReferences } from "./i-main-stair.js";

const references = new WeakMap();
const keyOf = (room) =>
  typeof room === "string" ? room : room?.roomId || room?.id;
const pairOf = (a, b) =>
  `${a.building}:${[a.floorId, b.floorId].sort().join(":")}`;
const finitePoint = (point) =>
  Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);

function prepare(graph) {
  if (references.has(graph)) return references.get(graph);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const stairs = graph.edges.filter(
    (edge) => edge.eligible && edge.kind === "stairs",
  );
  const layouts = [
    ...registry.layouts.filter((layout) => layout.campusId === graph.campusId),
    ...(graph.campusId === "v-78"
      ? [...entranceStairPortals, ...photographedStairCounterparts].map(
          (portal) => ({
            id: portal.layoutId,
            floorId: portal.floorId,
            sourceMarkerIds: [portal.sourceEdgeId],
            routingPortal: portal,
            label: portal.label
              ? `${portal.label}${portal.building ? ` · корпус ${portal.building}` : ""}`
              : "Лестница главного холла",
          }),
        )
      : []),
    ...(graph.campusId === "v-78"
      ? iMainStairReferences.map((ref) => ({
          id: ref.layoutId,
          floorId: ref.floorId,
          sourceMarkerIds: ref.portals.map((p) => p.sourceEdgeId),
          routingPortals: ref.portals,
          strictSourceMarkerMatch: true,
          label: "Главная лестница · корпус И",
        }))
      : []),
  ];
  const matchingNodes = (layout, edge) =>
    [nodes.get(edge.from), nodes.get(edge.to)].filter(
      (node) =>
        node?.floorId === layout.floorId &&
        (!layout.routingPortal ||
          (edge.sourceId === layout.routingPortal.sourceTransitionId &&
            Math.hypot(
              node.position[0] - layout.routingPortal.position[0],
              node.position[1] - layout.routingPortal.position[1],
            ) <= 0.001)) &&
        (!layout.routingPortals ||
          layout.routingPortals.some(
            (portal) =>
              edge.id === portal.sourceEdgeId &&
              edge.sourceId === portal.sourceTransitionId &&
              node.floorId === portal.floorId &&
              Math.hypot(
                node.position[0] - portal.position[0],
                node.position[1] - portal.position[1],
              ) <= 0.001,
          )) &&
        (!layout.building || node.building === layout.building) &&
        (layout.sourceMarkerIds?.includes(edge.id) ||
          (!layout.strictSourceMarkerMatch &&
            node.areaId === layout.fitAreaId)),
    );
  const preferred = new Set(),
    pairs = new Set();
  for (const edge of stairs) {
    const a = nodes.get(edge.from),
      b = nodes.get(edge.to);
    if (!a?.building || a.building !== b?.building || a.floorId === b.floorId)
      continue;
    if (
      layouts.some(
        (layout) =>
          layout.label === "ЛК2" && matchingNodes(layout, edge).length,
      )
    ) {
      preferred.add(edge.id);
      pairs.add(pairOf(a, b));
    }
  }
  const value = { nodes, stairs, layouts, matchingNodes, preferred, pairs };
  references.set(graph, value);
  return value;
}

/** Resolve a displayed staircase to its retained portal(s), not its decorative
 * centre. No nearest node, connector, fabricated doorway or new edge is used.
 * null means an ordinary catalogue endpoint; [] means an unbound staircase.
 */
export function stairEndpointCandidates(graph, endpoint) {
  const id = keyOf(endpoint);
  if (graph.rooms[id]) return null;
  const photo = typeof id === "string" && id.startsWith("photo-stair:");
  if (!photo && endpoint?.kind !== "stairs") return null;
  if (endpoint?.routingStatus === "display-only-no-source-transition")
    return [];
  const { nodes, stairs, layouts, matchingNodes } = prepare(graph);
  const layoutId = photo ? id.slice("photo-stair:".length) : endpoint?.layoutId;
  const layout = layouts.find((item) => item.id === layoutId);
  if (photo && !layout) return [];
  if (layout && endpoint?.floorId && endpoint.floorId !== layout.floorId)
    return [];
  const candidates = new Map();
  for (const edge of stairs) {
    const matches = layout
      ? matchingNodes(layout, edge)
      : [nodes.get(edge.from), nodes.get(edge.to)].filter((node) => {
          const position = endpoint?.position || endpoint?.center;
          return (
            node?.floorId === endpoint?.floorId &&
            endpoint?.sourceIds?.includes(edge.id) &&
            finitePoint(position) &&
            Math.hypot(
              node.position[0] - position[0],
              node.position[1] - position[1],
            ) <= 0.001
          );
        });
    for (const node of matches)
      candidates.set(node.id, {
        nodeId: node.id,
        floorId: node.floorId,
        originAreaId: node.areaId,
        label: endpoint?.label || layout?.label || "Лестница",
        kind: "stairs",
        endpointKind: "stairs",
      });
  }
  return [...candidates.values()];
}

/** A bounded preference, not a closure or an accessibility assertion. Original
 * source costs and distances stay intact. A different stair remains usable.
 */
export function staircasePreferencePenalty(graph, edge, enabled = true) {
  if (
    !enabled ||
    graph.campusId !== "v-78" ||
    graph.units !== "meters" ||
    edge.kind !== "stairs"
  )
    return 0;
  const { nodes, preferred, pairs } = prepare(graph);
  const a = nodes.get(edge.from),
    b = nodes.get(edge.to);
  return a &&
    b &&
    a.building === b.building &&
    pairs.has(pairOf(a, b)) &&
    !preferred.has(edge.id)
    ? 60
    : 0;
}
