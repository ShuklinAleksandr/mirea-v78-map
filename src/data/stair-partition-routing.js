import partitions from "./stair-partitions.json" with { type: "json" };
import { segmentCrossesSurveyInterior } from "./survey-routing.js";

/** Existing connections only. Confirmed dividers exclude crossing horizontal
 * edges at runtime, never add an alternative or rewrite the archived graph. */
export function getStairPartitionRoutingReport(graph) {
  const blocked = new Set();
  const regions = [];
  if (
    graph?.campusId !== partitions.campusId ||
    graph.source?.stairLayoutsSha256 !== partitions.sourceStairLayoutsSha256 ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  )
    return { blockedEdgeIds: [], regions };
  const active = partitions.regions.filter(
    (region) =>
      graph.source?.geometrySha256?.[region.floorId] ===
      partitions.sourceGeometrySha256[region.floorId],
  );
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const region of active) {
    const blockedEdgeIds = [];
    for (const edge of graph.edges) {
      if (!edge.eligible || !["corridor", "door"].includes(edge.kind)) continue;
      const a = nodes.get(edge.from),
        b = nodes.get(edge.to);
      if (
        a?.floorId !== region.floorId ||
        b?.floorId !== region.floorId ||
        (a.areaId !== region.areaId && b.areaId !== region.areaId)
      )
        continue;
      if (segmentCrossesSurveyInterior(a.position, b.position, region.points)) {
        blocked.add(edge.id);
        blockedEdgeIds.push(edge.id);
      }
    }
    regions.push({
      layoutId: region.layoutId,
      floorId: region.floorId,
      areaId: region.areaId,
      blockedEdgeIds,
    });
  }
  return { blockedEdgeIds: [...blocked], regions };
}

export function getStairPartitionBlockedEdges(graph) {
  return new Set(getStairPartitionRoutingReport(graph).blockedEdgeIds);
}
