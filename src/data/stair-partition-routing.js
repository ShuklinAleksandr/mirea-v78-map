import partitions from "./stair-partitions.json" with { type: "json" };
import { segmentCrossesSurveyInterior } from "./survey-routing.js";

// Apply reviewed geometry only to the source package it was checked against.
function activeRegions(graph, regions) {
  if (
    graph?.campusId !== partitions.campusId ||
    graph.source?.stairLayoutsSha256 !== partitions.sourceStairLayoutsSha256 ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  )
    return [];
  return regions.filter(
    (region) =>
      graph.source?.geometrySha256?.[region.floorId] ===
      partitions.sourceGeometrySha256[region.floorId],
  );
}

export function currentStairBarriers(graph) {
  return activeRegions(graph, [...partitions.regions, ...partitions.openings]);
}

function regionRoutingReport(graph, active) {
  const blocked = new Set();
  const regions = [];
  if (!active.length) return { blockedEdgeIds: [], regions };
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

export function getStairPartitionRoutingReport(graph) {
  return regionRoutingReport(graph, activeRegions(graph, partitions.regions));
}

export function getStairOpeningBlockedEdges(graph) {
  return new Set(
    regionRoutingReport(
      graph,
      activeRegions(graph, partitions.openings),
    ).blockedEdgeIds,
  );
}

export function getStairBlockedEdges(graph) {
  return new Set(
    regionRoutingReport(graph, currentStairBarriers(graph)).blockedEdgeIds,
  );
}

export function getStairPartitionBlockedEdges(graph) {
  return new Set(getStairPartitionRoutingReport(graph).blockedEdgeIds);
}
