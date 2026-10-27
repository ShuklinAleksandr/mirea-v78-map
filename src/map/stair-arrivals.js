import { getFloorMarkers } from "../data/utils.js";

const EPSILON = 1e-6;
const point = (value) =>
  Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
const near = (a, b, tolerance = EPSILON) =>
  point(a) && point(b) && Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;
const unique = (values) => [...new Set(values)];
const rounded = (value) =>
  typeof value === "number" ? Math.round(value * 1e7) / 1e7 : value;

function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

function onBoundary(p, ring, tolerance) {
  return ring.some((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0],
      dz = b[1] - a[1];
    const length = Math.hypot(dx, dz);
    if (length < EPSILON) return near(p, a, tolerance);
    const along = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / length;
    const across = Math.abs((p[0] - a[0]) * dz - (p[1] - a[1]) * dx) / length;
    return (
      across <= tolerance && along >= -tolerance && along <= length + tolerance
    );
  });
}

function contains(p, polygon, tolerance) {
  return (
    point(p) &&
    Array.isArray(polygon?.points) &&
    (inRing(p, polygon.points) || onBoundary(p, polygon.points, tolerance)) &&
    !(polygon.holes || []).some((hole) => inRing(p, hole))
  );
}

function validFrame(frame) {
  return (
    frame &&
    [frame.origin, frame.axisU, frame.axisV, frame.size].every(point) &&
    frame.size.every((value) => value > 0) &&
    Math.abs(Math.hypot(...frame.axisU) - 1) < 0.001 &&
    Math.abs(Math.hypot(...frame.axisV) - 1) < 0.001 &&
    Math.abs(
      frame.axisU[0] * frame.axisV[0] + frame.axisU[1] * frame.axisV[1],
    ) < 0.001
  );
}

function inFrame(p, layout, tolerance) {
  if (!point(p) || !validFrame(layout.frame)) return false;
  const delta = p.map((value, i) => value - layout.frame.origin[i]);
  return [layout.frame.axisU, layout.frame.axisV].every((axis, i) => {
    const value = delta[0] * axis[0] + delta[1] * axis[1];
    return value >= -tolerance && value <= layout.frame.size[i] + tolerance;
  });
}

function topology(layout) {
  if (!layout.flights?.length || !layout.landings?.length) return null;
  const shape = [
    layout.shape,
    layout.footprint,
    layout.flights.map((flight) => [
      flight.from,
      flight.to,
      flight.widthFraction ?? null,
      flight.width ?? null,
      flight.baseFraction,
      flight.topFraction,
      flight.treadCount ?? null,
    ]),
    layout.landings.map((landing) => [
      landing.points,
      landing.elevationFraction,
    ]),
  ];
  return JSON.stringify(shape, (_key, value) => rounded(value));
}

function observed(layout) {
  return (
    layout?.shapeStatus === "photo-plan-observed" &&
    Array.isArray(layout.sourcePhotoIds) &&
    layout.sourcePhotoIds.length &&
    layout.sourcePhotoIds.every((id) => typeof id === "string" && id.length) &&
    Array.isArray(layout.sourcePolygonIds) &&
    layout.sourcePolygonIds.includes(layout.fitAreaId) &&
    layout.footprint?.length >= 3 &&
    layout.footprint.every(point) &&
    Number.isFinite(layout.physicalFloor) &&
    validFrame(layout.frame) &&
    layout.flights?.length &&
    layout.landings?.length &&
    layout.flights.every(
      (flight) =>
        point(flight.from) &&
        point(flight.to) &&
        Number.isFinite(flight.baseFraction) &&
        Number.isFinite(flight.topFraction),
    ) &&
    layout.landings.every(
      (landing) =>
        Number.isFinite(landing.elevationFraction) &&
        landing.points?.length >= 3 &&
        landing.points.every(point),
    )
  );
}

/**
 * Audit a middle-floor incoming view without modifying its original ascent.
 * A real down transition and matching photographed topology on BOTH levels are
 * required. The current photo's own frame is used because source floor plans
 * are not horizontally registered closely enough for a literal lower-frame
 * overlay. This is a documented display placement, not a survey or new edge.
 */
export function inspectMiddleStairArrival(
  layout,
  floor,
  registry,
  options = {},
) {
  const result = (status, reason, extra = {}) => ({
    layoutId: layout?.id || null,
    status,
    reason,
    arrival: null,
    ...extra,
  });
  if (
    !layout ||
    !floor ||
    !Array.isArray(registry?.layouts) ||
    layout.floorId !== floor.id ||
    layout.campusId !== floor.campusId ||
    floor.units !== "meters" ||
    !Number.isFinite(floor.level)
  )
    return result("unavailable", "invalid-source-context");
  if (
    layout.levelRole ||
    layout.shapeReviewStatus ||
    layout.existenceStatus === "user-confirmed-existence"
  )
    return result("not-applicable", "explicit-or-user-confirmed-role");
  if (!observed(layout) || !layout.building || layout.physicalFloor < 2)
    return result("unavailable", "no-observed-middle-floor-shape");
  const building = registry.layouts.filter(
    (candidate) =>
      candidate.campusId === layout.campusId &&
      candidate.building === layout.building,
  );
  const last = Math.max(
    ...building.map((candidate) => candidate.physicalFloor || 0),
  );
  if (layout.physicalFloor >= last)
    return result("not-applicable", "last-photographed-floor");
  const minimum = Math.min(
    ...layout.flights.flatMap((flight) => [
      flight.baseFraction,
      flight.topFraction,
    ]),
    ...layout.landings.map((landing) => landing.elevationFraction),
  );
  const maximum = Math.max(
    ...layout.flights.flatMap((flight) => [
      flight.baseFraction,
      flight.topFraction,
    ]),
    ...layout.landings.map((landing) => landing.elevationFraction),
  );
  if (minimum !== 0 || maximum !== 1)
    return result("unavailable", "non-unit-ascent-profile");
  const matchingAreas = (floor.polygons || []).filter(
    (polygon) => polygon.id === layout.fitAreaId,
  );
  if (
    matchingAreas.length !== 1 ||
    !point(matchingAreas[0].center) ||
    matchingAreas[0].points?.length < 3 ||
    !matchingAreas[0].points?.every(point) ||
    !(matchingAreas[0].holes || []).every(
      (hole) => hole.length >= 3 && hole.every(point),
    )
  )
    return result("unavailable", "missing-current-source-cell");
  const area = matchingAreas[0];
  // Source door/portal anchors may sit a few centimetres on a cell boundary.
  // The allowance is in source metres, never 10% of a stair's dimensions.
  const tolerance = Math.max(0, Math.min(0.1, options.portalTolerance ?? 0.1));
  const markers = options.markers || getFloorMarkers(floor);
  const lowerLayouts = building.filter(
    (candidate) =>
      candidate.physicalFloor === layout.physicalFloor - 1 &&
      !candidate.levelRole &&
      !candidate.existenceStatus &&
      observed(candidate),
  );
  if (!lowerLayouts.length)
    return result("unavailable", "lower-photographed-shape-missing");
  const matches = [];
  const rejected = [];
  for (const marker of markers) {
    if (
      marker.kind !== "stairs" ||
      !contains(marker.center || marker.position, area, tolerance)
    )
      continue;
    for (const target of marker.targets || []) {
      const onLevel = lowerLayouts.filter(
        (candidate) => candidate.floorId === target.floorId,
      );
      if (!onLevel.length) continue;
      const atPortal = onLevel.filter((candidate) =>
        inFrame(target.center, candidate, tolerance),
      );
      if (atPortal.length !== 1) {
        rejected.push({
          sourceIds: marker.sourceIds || [marker.id],
          targetFloorId: target.floorId,
          reason: atPortal.length
            ? "ambiguous-lower-cell"
            : "lower-portal-outside-photo-frame",
        });
        continue;
      }
      const lower = atPortal[0];
      if (lower.floorId !== `${floor.campusId}-floor${floor.level - 1}`) {
        rejected.push({
          lowerLayoutId: lower.id,
          reason: "nonadjacent-source-levels",
        });
        continue;
      }
      if (topology(lower) !== topology(layout)) {
        rejected.push({
          lowerLayoutId: lower.id,
          reason: "different-photographed-topology",
        });
        continue;
      }
      const raw = [
        ...(floor.transitions || []),
        ...(floor.markers || []),
      ].filter(
        (source) =>
          source.kind === "stairs" &&
          near(
            source.position || source.center,
            marker.center || marker.position,
          ) &&
          source.targetFloorId === target.floorId &&
          near(source.targetPosition, target.center),
      );
      const sourceEdgeIds = unique(
        raw.map((source) => source.id).filter(Boolean),
      );
      if (!sourceEdgeIds.length) {
        rejected.push({
          lowerLayoutId: lower.id,
          reason: "source-transition-identity-missing",
        });
        continue;
      }
      matches.push({ lower, marker, target, sourceEdgeIds });
    }
  }
  const lowerIds = unique(matches.map(({ lower }) => lower.id));
  if (lowerIds.length !== 1)
    return result(
      "unavailable",
      lowerIds.length ? "ambiguous-lower-layouts" : "no-proven-lower-pair",
      { rejected },
    );
  const lower = matches[0].lower;
  const edgeIds = unique(matches.flatMap((match) => match.sourceEdgeIds));
  const incoming = {
    ...layout,
    id: `${layout.id}:incoming`,
    parentLayoutId: layout.id,
    levelRole: "upper-arrival",
    levelRoleSource: "paired-photo-plans-and-source-down-transition",
    incomingDisplayOnly: true,
    displayOnlyArrival: true,
    pairedLayoutId: lower.id,
    sourceLowerLayoutId: lower.id,
    sourceLowerFloorId: lower.floorId,
    sourceEdgeIds: edgeIds,
    sourceMarkerIds: edgeIds,
    sourcePhotoIds: unique([...layout.sourcePhotoIds, ...lower.sourcePhotoIds]),
    sourcePhotos: unique([
      ...(layout.sourcePhotos || []),
      ...(lower.sourcePhotos || []),
    ]),
    placementStatus: "current-photo-approximate-frame",
    horizontalStatus: "current-photo-approximate-frame",
    verticalStatus: "approximate",
    frame: {
      ...layout.frame,
      origin: [...layout.frame.origin],
      axisU: [...layout.frame.axisU],
      axisV: [...layout.frame.axisV],
      size: [...layout.frame.size],
    },
    sourcePolygonIds: [...layout.sourcePolygonIds],
    sourceCurrentPhotoIds: [...layout.sourcePhotoIds],
    sourceLowerPhotoIds: [...lower.sourcePhotoIds],
    displayCutout: true,
    displayCutoutPoints: area.points.map(([x, z]) => [
      area.center[0] + (x - area.center[0]) * 0.98,
      area.center[1] + (z - area.center[1]) * 0.98,
    ]),
    flights: layout.flights.map((flight) => ({
      ...flight,
      from: [...flight.from],
      to: [...flight.to],
      baseFraction: flight.baseFraction - 1,
      topFraction: flight.topFraction - 1,
    })),
    landings: layout.landings.map((landing) => ({
      ...landing,
      points: landing.points.map((p) => [...p]),
      elevationFraction: landing.elevationFraction - 1,
    })),
    evidence: {
      type: "matching-photo-topology-with-source-down-transition",
      currentLayoutId: layout.id,
      lowerLayoutId: lower.id,
      sourceEdgeIds: edgeIds,
      currentPhotoIds: [...layout.sourcePhotoIds],
      lowerPhotoIds: [...lower.sourcePhotoIds],
      horizontalBasis: "current-photo-cell-frame",
      note: "Оба фотоплана подтверждают одинаковую последовательность маршей. Входящий вид использует рамку текущего плана; высоты и горизонтальные привязки приблизительны. Новых связей графа нет.",
    },
  };
  return result("available", "matching-photo-pair-and-source-transition", {
    arrival: incoming,
    rejected,
  });
}

export function middleStairArrival(layout, floor, registry, options = {}) {
  return inspectMiddleStairArrival(layout, floor, registry, options).arrival;
}
