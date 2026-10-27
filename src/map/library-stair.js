import polygonClipping from "polygon-clipping";
import hallAdjacency from "../data/hall-adjacency.json" with { type: "json" };

const FLOOR_ID = "v-78-floor2";
const HALL_ID = "v-78-floor2-area-6";
const EDGE_ID = "v-78:edge:20734";
const SOURCE_POINT = [30.523, 33.1784];
const SOURCE_TARGET = [40.407, 22.8264];
const FRONT_WALL = [
  [29.075, 40.5804],
  [36.786, 39.0154],
];
const EXPECTED_PLACES = {
  "v-78--floor-2--9yc": {
    kind: "cloakroom",
    center: [24.382, 12.1754],
    points: [
      [18.957, 9.0584],
      [20.281, 13.8364],
      [21.597, 18.0174],
      [24.706, 31.2064],
      [27.548, 30.6744],
      [32.125, 29.8304],
      [27.905, 6.8954],
      [27.661, 6.4064],
    ],
    holes: [],
  },
  "v-78--floor-2--9yb": {
    kind: "entrance",
    center: [49.6884, 36.8394],
    points: [
      [43.5, 38.5824],
      [55.565, 39.2074],
      [56.252, 34.9524],
      [43.352, 34.2784],
      [43.359, 35.0964],
    ],
    holes: [],
  },
};
const epsilon = 1e-7;
const samePoint = (a, b) =>
  Array.isArray(a) &&
  a.length === 2 &&
  a.every(Number.isFinite) &&
  Math.hypot(a[0] - b[0], a[1] - b[1]) < epsilon;
const sameRing = (a, b) =>
  Array.isArray(a) &&
  a.length === b.length &&
  a.every((point, i) => samePoint(point, b[i]));
const rectangle = (u0, v0, u1, v1) => [
  [u0, v0],
  [u1, v0],
  [u1, v1],
  [u0, v1],
];

function matchingPlace(floor, id, expected) {
  const found = floor.polygons.filter((polygon) => polygon.id === id);
  if (found.length !== 1) return null;
  const polygon = found[0];
  return polygon.kind === expected.kind &&
    samePoint(polygon.center, expected.center) &&
    sameRing(polygon.points, expected.points) &&
    Array.isArray(polygon.holes) &&
    polygon.holes.length === expected.holes.length &&
    polygon.holes.every((ring, i) => sameRing(ring, expected.holes[i]))
    ? polygon
    : null;
}

function matchingHall(floor) {
  const expected = hallAdjacency.expectedPolygons[HALL_ID];
  const raw = matchingPlace(floor, HALL_ID, expected);
  if (raw) return raw;
  const view = floor.userConfirmedDisplayAdjacency;
  const found = floor.polygons.filter((polygon) => polygon.id === HALL_ID);
  if (
    found.length !== 1 ||
    view?.applied !== true ||
    view.type !== "user-confirmed-room-adjacency" ||
    view.sourceHallId !== HALL_ID ||
    view.sourceGeometrySha256 !== hallAdjacency.sourceGeometrySha256
  )
    return null;
  const hall = found[0];
  if (
    hall.kind !== expected.kind ||
    !samePoint(hall.center, expected.center) ||
    hall.sourcePolygonId !== HALL_ID ||
    hall.geometryStatus !== "user-adjacency-approximate-dimensions" ||
    hall.displayEvidence?.sourceGeometrySha256 !==
      hallAdjacency.sourceGeometrySha256 ||
    !Array.isArray(hall.points) ||
    !Array.isArray(hall.holes)
  )
    return null;
  // The documented buffet adjacency changes the distant back of the hall.
  // Its entrance/wardrobe boundary must still match every local source edge.
  // Boolean clipping may rotate or reverse the ring, hence undirected edges.
  const localBoundary = [
    [32.125, 29.8304],
    [27.548, 30.6744],
    ...FRONT_WALL,
    [35.895, 32.8094],
    [39.849, 32.4304],
  ];
  const hasEdge = (a, b) =>
    hall.points.some((point, i) => {
      const next = hall.points[(i + 1) % hall.points.length];
      return (
        (samePoint(point, a) && samePoint(next, b)) ||
        (samePoint(point, b) && samePoint(next, a))
      );
    });
  return localBoundary
    .slice(1)
    .every((point, i) => hasEdge(localBoundary[i], point))
    ? hall
    : null;
}

function matchingTransition(collection) {
  if (!Array.isArray(collection)) return false;
  const found = collection.filter((marker) => marker.id === EDGE_ID);
  if (found.length !== 1) return false;
  const marker = found[0];
  return (
    marker.kind === "stairs" &&
    marker.sourceId === "tr-MXJSer576" &&
    marker.source === "source-navigation-graph" &&
    marker.confidence === "source-graph" &&
    samePoint(marker.position, SOURCE_POINT) &&
    marker.targetFloorId === "v-78-floor1" &&
    samePoint(marker.targetPosition, SOURCE_TARGET)
  );
}

/**
 * Display only the upper library descent confirmed beside the wardrobe.
 * The graph supplies two portals, not the staircase's intervening trajectory.
 * The user's direction and 180-degree turn determine this local schematic;
 * its lower endpoint is never shifted to the unrelated lower graph position.
 */
export function libraryStairLayoutsForFloor(floor) {
  if (
    floor?.campusId !== "v-78" ||
    floor.id !== FLOOR_ID ||
    floor.level !== 2 ||
    floor.units !== "meters" ||
    !Array.isArray(floor.polygons) ||
    !matchingTransition(floor.markers) ||
    !matchingTransition(floor.transitions)
  )
    return [];
  const hall = matchingHall(floor);
  if (
    !hall ||
    !Object.entries(EXPECTED_PLACES).every(([id, expected]) =>
      matchingPlace(floor, id, expected),
    )
  )
    return [];

  const wallDelta = [
    FRONT_WALL[1][0] - FRONT_WALL[0][0],
    FRONT_WALL[1][1] - FRONT_WALL[0][1],
  ];
  const wallLength = Math.hypot(...wallDelta);
  const axisU = wallDelta.map((value) => value / wallLength);
  // The +V normal points toward the outside wall on the main entrance side.
  const axisV = [-axisU[1], axisU[0]];
  const size = [3.6, 5.5];
  const firstFrom = [0.25, 0.1];
  const origin = SOURCE_POINT.map(
    (value, i) =>
      value -
      axisU[i] * firstFrom[0] * size[0] -
      axisV[i] * firstFrom[1] * size[1],
  );
  const world = ([u, v]) =>
    origin.map(
      (value, i) => value + axisU[i] * u * size[0] + axisV[i] * v * size[1],
    );
  const footprint = rectangle(0.04, 0.04, 0.96, 0.98);
  // An exact polygon check also protects against crossing a concave boundary
  // between sampled vertices. Do not clip or expand the source hall to fit.
  const outside = polygonClipping.difference(
    [footprint.map(world)],
    [hall.points, ...hall.holes],
  );
  if (outside.length) return [];
  const note =
    "Вниз к стене главного входа, площадка и разворот на 180°. Показаны стенки и нижняя площадка. Схема по вашему описанию; размеры и высота приблизительные. Физический этаж коридора и точный нижний выход не установлены.";
  const flight = (from, to, baseFraction, topFraction) => ({
    from,
    to,
    baseFraction,
    topFraction,
    widthFraction: 0.4,
    treadCount: null,
    treadCountStatus: "model-tessellation-not-measured",
    sourceTransitionId: null,
  });
  return [
    {
      id: "v-78-floor2-user-stair-library",
      campusId: "v-78",
      floorId: FLOOR_ID,
      building: null,
      physicalFloor: 2,
      label: "Спуск к библиотеке · корпус И",
      center: [...SOURCE_POINT],
      geometryCenter: world([0.5, 0.5]),
      focusDirectionLocal: [0.12, 3, -0.2],
      frame: { origin, axisU, axisV, size },
      sourcePolygonIds: [HALL_ID],
      fitAreaId: HALL_ID,
      sourceMarkerIds: [EDGE_ID],
      strictSourceMarkerMatch: true,
      sourcePhotoIds: [],
      sourcePhotos: [],
      shapeSourcePhotoIds: [],
      shapeSourcePhotos: [],
      shape: "user-confirmed-library-return-stair",
      layoutMode: "u-return",
      shapeStatus: "user-confirmed-topology-schematic-dimensions",
      shapeReviewStatus: "user-confirmed-schematic",
      geometryStatus: "user-confirmed-schematic",
      geometrySource: "user-description",
      geometryEvidence: "user-description",
      existenceStatus: "user-confirmed-existence",
      dimensionsStatus: "model-assumptions-not-measured",
      placementStatus: "schematic-within-known-hall-approximate",
      verticalStatus: "approximate",
      ascentDirectionStatus: "user-confirmed-descent-toward-entrance-wall",
      levelRole: "upper-arrival",
      levelRoleSource: "user-confirmed-downward-flight",
      pairedLayoutId: undefined,
      footprint,
      displayCutout: true,
      // The narrow full-height strip between the two former U cuts hid the
      // returning flight. Open one bounded local shaft; its departure platform
      // is recreated below and source polygons remain untouched.
      displayCutoutFootprints: [footprint.map((point) => [...point])],
      enclosureStatus: "user-confirmed-walls-approximate-interior",
      interiorDisplayStatus: "local-stairwell-cutaway-not-a-lower-floor-plan",
      enclosureWalls: footprint.map((point, i) => ({
        from: [...point],
        to: [...footprint[(i + 1) % footprint.length]],
        bottomFraction: -1,
        topFraction: 0,
        thickness: 0.14,
      })),
      flights: [
        flight(firstFrom, [0.25, 0.78], 0, -0.5),
        flight([0.75, 0.78], [0.75, 0.1], -0.5, -1),
      ],
      landings: [
        {
          role: "intermediate",
          points: rectangle(0.04, 0.78, 0.96, 0.98),
          elevationFraction: -0.5,
          railEdges: [1, 2, 3],
        },
        {
          role: "departure",
          points: rectangle(0.04, 0.04, 0.46, 0.1),
          elevationFraction: 0,
          railEdges: [],
        },
        {
          role: "arrival-display-only",
          points: rectangle(0.54, 0.04, 0.96, 0.1),
          elevationFraction: -1,
          railEdges: [],
        },
        {
          role: "shaft-bottom-display-only",
          points: footprint.map((point) => [...point]),
          elevationFraction: -1.05,
          railEdges: [],
        },
      ],
      destinationLabel: "Библиотечный коридор · этаж уточняется",
      destinationStatus: "physical-level-and-lower-placement-unconfirmed",
      routingStatus: "display-only-no-source-flight-path",
      evidence: {
        type: "user-confirmed-topology",
        confirmedAt: "2026-10-25",
        description:
          "Первый спуск в сторону стены главного входа с улицы, затем площадка и разворот на 180°.",
      },
      note,
    },
  ];
}
