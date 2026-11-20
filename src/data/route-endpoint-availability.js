// Search records from the source catalogue use room anchors. Additional
// display stairs need a source transition on this exact floor; a mesh centre
// or an unnamed floor polygon alone does not identify a routing destination.
export function hasRouteEndpoint(place, searchRecord, floor) {
  if (!place || place.routingStatus === "display-only-no-source-transition")
    return false;
  if (
    searchRecord &&
    searchRecord.searchEvidence !== "user-confirmed-stair-display"
  )
    return true;
  return (
    place.kind === "stairs" &&
    Boolean(
      floor?.transitions?.some(
        (edge) =>
          edge.kind === "stairs" &&
          edge.targetFloorId &&
          place.sourceIds?.includes(edge.id),
      ),
    )
  );
}
