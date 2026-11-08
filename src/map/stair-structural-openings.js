import polygonClipping from "polygon-clipping";

/** Display-only cutouts from the same accepted profiles as the clean solids.
 * No convex hull bridges unrelated flights or removes the arrival landing. */
export function structuralStairOpenings(layout, floor, reference) {
  const frame = layout.frame;
  const world = ([u, v]) => [
    frame.origin[0] +
      frame.axisU[0] * u * frame.size[0] +
      frame.axisV[0] * v * frame.size[1],
    frame.origin[1] +
      frame.axisU[1] * u * frame.size[0] +
      frame.axisV[1] * v * frame.size[1],
  ];
  const flights = layout.flights.filter((flight) =>
    layout.incomingDisplayOnly
      ? Math.abs(flight.topFraction) < 1e-6
      : Math.min(flight.baseFraction, flight.topFraction) < -1e-6,
  );
  const lowest = Math.min(
    ...flights.flatMap((flight) => [flight.baseFraction, flight.topFraction]),
  );
  const outlines = flights.map((flight) => {
    const a = world(flight.from),
      b = world(flight.to);
    const dx = b[0] - a[0],
      dz = b[1] - a[1],
      length = Math.hypot(dx, dz);
    const alongU =
      Math.abs(flight.to[0] - flight.from[0]) >
      Math.abs(flight.to[1] - flight.from[1]);
    const half =
      (flight.width ?? flight.widthFraction * frame.size[alongU ? 1 : 0]) / 2 +
      0.012;
    const side = [(-dz / length) * half, (dx / length) * half];
    return [
      [a[0] + side[0], a[1] + side[1]],
      [b[0] + side[0], b[1] + side[1]],
      [b[0] - side[0], b[1] - side[1]],
      [a[0] - side[0], a[1] - side[1]],
    ];
  });
  for (const landing of layout.landings || [])
    if (
      landing.elevationFraction < -1e-6 &&
      landing.elevationFraction >= lowest - 1e-6
    )
      outlines.push(landing.points.map(world));
  if (!outlines.length) return [];
  // The broad rectangular cell has an observed central well. Retain that
  // opening; never hide it beneath an invented floor spanning the cell.
  if (reference.assetId === "standard-cell")
    outlines.push(
      [
        [0.24, 0.22],
        [0.76, 0.22],
        [0.76, 0.7],
        [0.24, 0.7],
      ].map(world),
    );
  const area =
    floor.polygons?.find((p) => p.id === layout.fitAreaId) ||
    floor.polygons?.find((p) => p.id === layout.containerAreaId);
  const frameRing = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map(world);
  return polygonClipping
    .intersection(
      polygonClipping.union(...outlines.map((ring) => [ring])),
      [frameRing],
      ...(layout.displayCutoutPoints ? [[layout.displayCutoutPoints]] : []),
      ...(area ? [[area.points, ...(area.holes || [])]] : []),
    )
    .map((polygon, openingIndex) => ({
      layoutId: layout.id,
      sourcePolygonIds: layout.sourcePolygonIds,
      openingIndex,
      points: polygon[0].slice(0, -1),
      geometryEvidence:
        "accepted-descending-flight-and-landing-profile-with-observed-central-well",
      sourceSha256: reference.sourceSha256,
      modelApproximation: true,
    }));
}
