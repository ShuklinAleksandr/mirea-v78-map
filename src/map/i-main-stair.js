import polygonClipping from "polygon-clipping";
import { iMainStairReferences } from "../data/i-main-stair.js";

const samePoint = (a, b) =>
  Array.isArray(a) &&
  a.length === 2 &&
  a.every((n, i) => Number.isFinite(n) && Math.abs(n - b[i]) < 1e-7);
const rectangle = (x, y, X, Y) => [
  [x, y],
  [X, y],
  [X, Y],
  [x, Y],
];
const note =
  "Главная лестница корпуса И по описанию пользователя 12 ноября: из центра две ветви идут к боковым миниплощадкам, разворачиваются и сходятся на общей центральной площадке следующего этажа. Повторяется на имеющихся этажах И1–И3. Размеры, высота, количество ступеней и ориентация в клетке приблизительные. Используются собственные исходные контуры и порталы; новые этажи и соединения не добавлены.";

function profile(offset = 0) {
  const flight = (branch, from, to, base, top) => ({
    branch,
    from,
    to,
    baseFraction: base + offset,
    topFraction: top + offset,
    widthFraction: 0.32,
    treadCount: null,
    treadCountStatus: "model-tessellation-not-measured",
    sourceTransitionId: null,
  });
  return {
    flights: [
      flight("left", [0.4, 0.25], [0.12, 0.25], 0, 0.5),
      flight("left", [0.12, 0.75], [0.4, 0.75], 0.5, 1),
      flight("right", [0.6, 0.25], [0.88, 0.25], 0, 0.5),
      flight("right", [0.88, 0.75], [0.6, 0.75], 0.5, 1),
    ],
    landings: [
      {
        role: "intermediate",
        branch: "left",
        points: rectangle(0.02, 0.09, 0.12, 0.91),
        elevationFraction: 0.5 + offset,
        railEdges: [0, 2, 3],
      },
      {
        role: "intermediate",
        branch: "right",
        points: rectangle(0.88, 0.09, 0.98, 0.91),
        elevationFraction: 0.5 + offset,
        railEdges: [0, 1, 2],
      },
      {
        role: "central-departure",
        points: rectangle(0.4, 0.09, 0.6, 0.41),
        elevationFraction: offset,
        railEdges: [],
      },
      {
        role: "central-arrival",
        points: rectangle(0.4, 0.59, 0.6, 0.91),
        elevationFraction: 1 + offset,
        railEdges: [],
      },
    ],
  };
}

/** Only the large И staircase confirmed by the user, with exact native guards.
 * Independent first/middle/top views; no copied main-A frame or guessed floor. */
export function iMainStairLayoutsForFloor(floor) {
  const ref = iMainStairReferences.find((r) => r.floorId === floor?.id);
  if (
    !ref ||
    floor.campusId !== "v-78" ||
    floor.units !== "meters" ||
    floor.level !== ref.physicalFloor ||
    floor.buildingLevels?.И !== ref.physicalFloor ||
    !Array.isArray(floor.polygons)
  )
    return [];
  const found = floor.polygons.filter((p) => p.id === ref.sourceArea.id);
  const area = found[0],
    expected = ref.sourceArea;
  if (
    found.length !== 1 ||
    area.kind !== expected.kind ||
    area.sourceGeometry !== expected.sourceGeometry ||
    !samePoint(area.center, expected.center) ||
    area.points?.length !== expected.points.length ||
    !area.points.every((p, i) => samePoint(p, expected.points[i])) ||
    area.holes?.length !== 0
  )
    return [];
  if (
    !ref.portals.every((portal) =>
      [floor.markers, floor.transitions].every((collection) => {
        const matches = collection?.filter((m) => m.id === portal.sourceEdgeId);
        const marker = matches?.[0];
        return (
          matches?.length === 1 &&
          marker.kind === "stairs" &&
          marker.source === "source-navigation-graph" &&
          marker.confidence === "source-graph" &&
          marker.sourceId === portal.sourceTransitionId &&
          samePoint(marker.position, portal.position) &&
          marker.targetFloorId === portal.targetFloorId &&
          samePoint(marker.targetPosition, portal.targetPosition)
        );
      }),
    )
  )
    return [];
  const frame = ref.frame;
  const world = ([u, v]) =>
    frame.origin.map(
      (n, i) =>
        n +
        frame.axisU[i] * u * frame.size[0] +
        frame.axisV[i] * v * frame.size[1],
    );
  const footprint = rectangle(0, 0, 1, 1);
  if (polygonClipping.difference([footprint.map(world)], [area.points]).length)
    return [];
  const lower = ref.physicalFloor === 1,
    top = ref.physicalFloor === 3;
  const base = {
    id: ref.layoutId,
    campusId: "v-78",
    floorId: floor.id,
    building: "И",
    physicalFloor: ref.physicalFloor,
    label: "Главная лестница",
    center: [...ref.portals[0].position],
    geometryCenter: world([0.5, 0.5]),
    frame,
    footprint,
    fitAreaId: area.id,
    containerAreaId: area.id,
    sourcePolygonIds: [area.id],
    sourceMarkerIds: ref.portals.map((p) => p.sourceEdgeId),
    sourcePortals: ref.portals,
    strictSourceMarkerMatch: true,
    sourcePhotoIds: [],
    sourcePhotos: [],
    shapeSourcePhotoIds: [],
    shapeSourcePhotos: [],
    shape: "mirrored-side-return-branches",
    layoutMode: "mirrored-side-return-branches",
    shapeStatus: "user-confirmed-topology-schematic-dimensions",
    shapeReviewStatus: "user-confirmed-schematic",
    geometryStatus: "user-confirmed-schematic",
    geometrySource: "user-description",
    geometryEvidence: "user-confirmed-I-main-stair-2026-11-12",
    existenceStatus: "user-confirmed-existence",
    dimensionsStatus: "model-assumptions-not-measured",
    placementStatus: "schematic-within-own-native-I-cell",
    verticalStatus: "approximate",
    orientationStatus: "model-orientation-within-native-cell-not-surveyed",
    ascentDirectionStatus: "user-confirmed-center-side-center-topology",
    evidence: {
      type: "user-confirmed-topology",
      confirmedAt: "2026-11-12",
      description: note,
    },
    levelRole: top ? "upper-arrival" : "lower-departure",
    levelRoleSource: "existing-source-transitions-and-user-confirmed-topology",
    // Look into the narrow native cell rather than hiding the lower flights
    // behind its existing corridor wall when a user selects the staircase.
    focusDirectionLocal: [0.05, 3, 1],
    note,
  };
  if (top)
    return [
      {
        ...base,
        ...profile(-1),
        displayCutout: true,
        displayCutoutFootprints: [
          rectangle(0.02, 0.09, 0.4, 0.91),
          rectangle(0.6, 0.09, 0.98, 0.91),
        ],
      },
    ];
  const up = { ...base, ...profile() };
  if (lower) return [up];
  return [
    {
      ...up,
      incomingDisplay: {
        ...base,
        id: `${ref.layoutId}:incoming`,
        ...profile(-1),
        levelRole: "upper-arrival",
        incomingDisplayOnly: true,
        displayCutout: true,
        displayCutoutPoints: footprint.map(world),
        sourceLowerLayoutId: iMainStairReferences[0].layoutId,
        sourceEdgeIds: ref.portals
          .filter((p) => p.targetFloorId === "v-78-floor1")
          .map((p) => p.sourceEdgeId),
      },
    },
  ];
}
