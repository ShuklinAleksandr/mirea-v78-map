import polygonClipping from "polygon-clipping";
import { getFloorMarkers } from "../data/utils.js";
import dBindings from "../data/stair-scan-bindings.json" with { type: "json" };

// Small provenance/placement registry. Full diagnostic scan meshes are not
// imported by the application; tests verify these fields against the archive.
export const stairScanMetadata = {
  "grand-upper": {
    floorRange: [-1.575, 3.775],
    sourceSha256:
      "9e327c70bec30f5793158a07a9fd11e2d09bebcd4eaab892389632b18afe6bcb",
  },
  "standard-cell": {
    floorRange: [-1.375, 2.475],
    sourceSha256:
      "521afad8667ae52e9e472fa3f79babbc13ed1efbeac32b9f28ae5e6cc281b446",
  },
  "grand-lower": {
    floorRange: [-9.375, -1.375],
    sourceSha256:
      "30dc9afe4872e1269c9d4176226a43b34bc09d31983f8a83a5b46221037986cf",
  },
};
const sources = stairScanMetadata;
const grandUpper = sources["grand-upper"];
const standardCell = sources["standard-cell"];
const dLayoutCache = new WeakMap();
const epsilon = 1e-7;
const point = (p) =>
  Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

export function stairScanBinding(layout) {
  if (!layout) return null;
  if (
    layout.id === "v-78-floor2-photo-stair-wide-hall" ||
    layout.id === "v-78-floor3-photo-stair-wide-hall"
  )
    return {
      assetId: "grand-upper",
      floorRange: grandUpper.floorRange,
      evidence: "user-identified-main-upper-scan",
    };
  if (
    [
      "v-78-floor1-photo-stair-A154",
      "v-78-floor2-photo-stair-A154-arrival",
    ].includes(layout.id)
  )
    return {
      assetId: "grand-lower",
      floorRange: [-5.475, -1.375],
      evidence: "upper-storey-of-user-identified-lower-scan",
    };
  if (layout.id === "v-78-floor1-user-stair-basement")
    return {
      assetId: "grand-lower",
      floorRange: [-9.375, -5.475],
      evidence: "lower-storey-of-user-identified-lower-scan-display-only",
    };
  if (
    layout.scanTemplateId === "standard-cell" ||
    (layout.shape === "wide-well-U" && ["Г", "В"].includes(layout.building))
  )
    return {
      assetId: "standard-cell",
      floorRange: standardCell.floorRange,
      evidence:
        layout.scanBindingEvidence ||
        "user-authorized-equivalent-standard-scan",
    };
  return null;
}

/** Provenance for the clean plan/profile display. The original observed mesh
 * remains available through createStairScanVisual for diagnostic comparison. */
export function stairScanReference(layout) {
  const binding = stairScanBinding(layout);
  if (!binding) return null;
  return {
    assetId: binding.assetId,
    sourceSha256: sources[binding.assetId].sourceSha256,
    sourceFloorRange: [...binding.floorRange],
    evidence: binding.evidence,
    display: "clean-supported-flight-and-landing-profile",
    dimensions: "model-approximation-not-measured",
    observedMeshPreserved: true,
  };
}

function samePoint(a, b) {
  return (
    point(a) && point(b) && a.every((n, i) => Math.abs(n - b[i]) < epsilon)
  );
}

function frameInsideSourceCell(area, portals) {
  const up = portals.find((p) => p.role === "up");
  const down = portals.find((p) => p.role === "down");
  let direction =
    up && down
      ? down.position.map((n, i) => n - up.position[i])
      : area.points
          .map((p, i) =>
            area.points[(i + 1) % area.points.length].map((n, j) => n - p[j]),
          )
          .filter((v) => v[0] > 0 && v[1] > 0)
          .sort((a, b) => Math.hypot(...b) - Math.hypot(...a))[0];
  if (!direction || Math.hypot(...direction) < 1) return null;
  const length = Math.hypot(...direction);
  const axisU = direction.map((n) => n / length),
    axisV = [-axisU[1], axisU[0]];
  const projections = area.points.map((p) => [
    p[0] * axisU[0] + p[1] * axisU[1],
    p[0] * axisV[0] + p[1] * axisV[1],
  ]);
  const min = [0, 1].map((i) => Math.min(...projections.map((p) => p[i])));
  const max = [0, 1].map((i) => Math.max(...projections.map((p) => p[i])));
  const center = min.map((n, i) => (n + max[i]) / 2);
  for (let factor = 0.98; factor >= 0.78; factor -= 0.02) {
    const size = min.map((n, i) => (max[i] - n) * factor);
    const low = center.map((n, i) => n - size[i] / 2);
    const origin = [
      axisU[0] * low[0] + axisV[0] * low[1],
      axisU[1] * low[0] + axisV[1] * low[1],
    ];
    const world = ([u, v]) =>
      origin.map((n, i) => n + axisU[i] * u * size[0] + axisV[i] * v * size[1]);
    const corners = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ].map(world);
    if (
      polygonClipping.difference(
        [corners],
        [area.points, ...(area.holes || [])],
      ).length
    )
      continue;
    const containsPortals = portals.every(({ position }) => {
      const d = position.map((n, i) => n - origin[i]);
      return [axisU, axisV].every((axis, i) => {
        const value = d[0] * axis[0] + d[1] * axis[1];
        return value >= -0.25 && value <= size[i] + 0.25;
      });
    });
    if (containsPortals)
      return {
        origin,
        axisU,
        axisV,
        size,
        status: "source-cell-and-portal-axis-uniform-inset-approximate",
      };
  }
  return null;
}

/** The user identifies the scan as the same type in D. Exact source guards
 * establish the existing cell/portals, not measured scan registration. The large
 * first-floor extra region remains unmapped rather than receiving a random box. */
export function scanBackedStairLayoutsForFloor(floor) {
  if (!floor || floor.campusId !== "v-78" || floor.units !== "meters")
    return [];
  const binding = dBindings.bindings.find((b) => b.floorId === floor.id);
  if (!binding || floor.buildingLevels?.Д !== binding.physicalFloor) return [];
  const area = floor.polygons?.find((p) => p.id === binding.areaId);
  if (
    !area ||
    !point(area.center) ||
    JSON.stringify(area.points) !== JSON.stringify(binding.points) ||
    JSON.stringify(area.holes || []) !== JSON.stringify(binding.holes)
  )
    return [];
  const markers = getFloorMarkers(floor);
  if (
    !binding.portals.every((portal) =>
      markers.some(
        (m) =>
          m.kind === "stairs" &&
          m.sourceIds?.includes(portal.edgeId) &&
          samePoint(m.center, portal.position) &&
          m.targets?.some(
            (t) =>
              t.floorId === portal.targetFloorId &&
              samePoint(t.center, portal.targetPosition),
          ),
      ),
    )
  )
    return [];
  // Guard the live source before reuse: an in-place portal/cell edit must not
  // leave a formerly accepted display binding active.
  const centerKey = JSON.stringify(area.center);
  const cached = dLayoutCache.get(floor);
  if (cached?.centerKey === centerKey) return cached.layouts;
  const frame = frameInsideSourceCell(area, binding.portals);
  if (!frame) return [];
  const up = binding.portals.find((p) => p.role === "up"),
    down = binding.portals.find((p) => p.role === "down");
  const id = `v78-Д-scan-${floor.id}`;
  const flights = [
    {
      from: [0.13, 0.7],
      to: [0.13, 0.22],
      widthFraction: 0.22,
      baseFraction: 0,
      topFraction: 0.5,
    },
    {
      from: [0.87, 0.22],
      to: [0.87, 0.7],
      widthFraction: 0.22,
      baseFraction: 0.5,
      topFraction: 1,
    },
  ];
  const layout = {
    id,
    campusId: "v-78",
    floorId: floor.id,
    building: "Д",
    physicalFloor: binding.physicalFloor,
    label: "Межэтажная лестница",
    center: [...area.center],
    geometryCenter: [...area.center],
    fitAreaId: area.id,
    containerAreaId: area.id,
    sourcePolygonIds: [area.id],
    sourceCellPoints: area.points.map((p) => [...p]),
    sourceMarkerIds: binding.portals.map((p) => p.edgeId),
    sourcePhotoIds: [],
    sourcePhotos: [],
    shape: "scan-equivalent-wide-well-U",
    shapeReviewStatus: "user-confirmed-schematic",
    shapeStatus: "user-authorized-equivalent-scan-with-source-portals",
    existenceStatus: "user-confirmed-existence",
    geometrySource: "user-scan-and-existing-source-portals",
    geometryEvidence: dBindings.evidence,
    placementStatus: dBindings.placementStatus,
    dimensionsStatus: "uniform-xy-fit-and-explicit-assumed-height-fit",
    verticalStatus: "explicit-fit-to-assumed-floor-rise",
    scanTemplateId: "standard-cell",
    scanBindingEvidence: dBindings.evidence,
    frame,
    footprint: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    flights,
    // The same user-confirmed broad cell type has a rear return landing and
    // two floor-level side landings. These normalized display proportions are
    // shared with the accepted G/V profile, not newly surveyed D dimensions.
    landings: [
      {
        points: [
          [0.02, 0.02],
          [0.98, 0.02],
          [0.98, 0.22],
          [0.02, 0.22],
        ],
        elevationFraction: 0.5,
        railEdges: [2],
      },
      {
        points: [
          [0.02, 0.7],
          [0.24, 0.7],
          [0.24, 0.94],
          [0.02, 0.94],
        ],
        elevationFraction: 0,
      },
      {
        points: [
          [0.76, 0.7],
          [0.98, 0.7],
          [0.98, 0.94],
          [0.76, 0.94],
        ],
        elevationFraction: 1,
      },
    ],
    routingStatus: "existing-source-transitions-only-no-added-edges",
    note: "Чистая модель подтверждённого пользователем типа лестницы по скану и существующим привязкам. Размеры, число ступеней и высота приблизительны; исходный скан сохранён. Новых связей графа нет.",
  };
  if (!up) {
    layout.levelRole = "upper-arrival";
    layout.displayCutout = true;
    layout.scanDerivedCutout = true;
    layout.pairedLayoutId = "v78-Д-scan-v-78-floor2";
    layout.flights = flights.map((f) => ({
      ...f,
      baseFraction: f.baseFraction - 1,
      topFraction: f.topFraction - 1,
    }));
    layout.landings = layout.landings.map((landing) => ({
      ...landing,
      elevationFraction: landing.elevationFraction - 1,
    }));
  } else if (down) {
    layout.incomingDisplay = {
      ...layout,
      id: `${id}:incoming`,
      levelRole: "upper-arrival",
      incomingDisplayOnly: true,
      displayCutout: true,
      scanDerivedCutout: true,
      sourceEdgeIds: [down.edgeId],
      sourceMarkerIds: [down.edgeId],
      pairedLayoutId:
        floor.id === "v-78-floor2" ? "v78-Д-scan-v-78-floor1" : undefined,
      flights: flights.map((f) => ({
        ...f,
        baseFraction: f.baseFraction - 1,
        topFraction: f.topFraction - 1,
      })),
      landings: layout.landings.map((landing) => ({
        ...landing,
        elevationFraction: landing.elevationFraction - 1,
      })),
    };
  }
  const layouts = [layout];
  dLayoutCache.set(floor, { centerKey, layouts });
  return layouts;
}
