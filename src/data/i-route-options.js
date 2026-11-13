import { findNavigationRoute } from "./entrance-route.js";
import { AI_OUTDOOR_PASSAGE } from "./outdoor-passage.js";
import {
  LIBRARY_PASSAGE_EDGE_ID,
  withLibraryPassageGraph,
} from "./library-passage.js";

const roomKey = (room) =>
  typeof room === "string" ? room : room?.roomId || room?.id;
const streetEdgeCache = new WeakMap();
function streetEdges(graph) {
  if (streetEdgeCache.has(graph)) return streetEdgeCache.get(graph);
  const nodes = new Set(
    graph.nodes
      .filter((node) => node.areaId === AI_OUTDOOR_PASSAGE.id)
      .map((node) => node.id),
  );
  const edges = graph.edges
    .filter((edge) => nodes.has(edge.from) || nodes.has(edge.to))
    .map((edge) => edge.id);
  streetEdgeCache.set(graph, edges);
  return edges;
}

/** Alternatives constrain existing passages. They never create an approach,
 * replace an unreachable room, or pretend that two identical paths differ. */
export function findIRouteOptions(sourceGraph, from, to, options = {}) {
  const graph = withLibraryPassageGraph(sourceGraph);
  const direct = findNavigationRoute(graph, from, to, options);
  const destination = graph.rooms[roomKey(to)] || to;
  const origin = graph.rooms[roomKey(from)] || from;
  if (
    !direct.ok ||
    graph.campusId !== "v-78" ||
    destination?.building !== "И" ||
    origin?.building === "И"
  )
    return direct;
  const blocked = options.blockedEdgeIds || [];
  const variants = [
    {
      id: "library",
      label: "Через библиотеку",
      description: "По внутреннему коридору",
      blocked: streetEdges(graph),
      usesPassage: (route) =>
        route.edges?.some((edge) => edge.id === LIBRARY_PASSAGE_EDGE_ID),
    },
    {
      id: "street",
      label: "По улице",
      description: "Через уличный переход А → И",
      blocked: [LIBRARY_PASSAGE_EDGE_ID],
      usesPassage: (route) =>
        route.graphNodes?.some((node) => node.areaId === AI_OUTDOOR_PASSAGE.id),
    },
  ].flatMap((variant) => {
    const route = findNavigationRoute(graph, from, to, {
      ...options,
      blockedEdgeIds: [...blocked, ...variant.blocked],
    });
    if (!route.ok || !variant.usesPassage(route)) return [];
    return [
      {
        id: variant.id,
        label: variant.label,
        description: variant.description,
        route: {
          ...route,
          routeOptionId: variant.id,
          routeOptionLabel: variant.label,
        },
      },
    ];
  });
  if (variants.length < 2) return variants[0]?.route || direct;
  return { ...variants[0].route, routeOptions: variants };
}
