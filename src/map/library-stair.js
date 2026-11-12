import polygonClipping from "polygon-clipping";
import { entranceStairPortals } from "../data/entrance-stair-portals.js";
import hallAdjacency from "../data/hall-adjacency.json" with { type: "json" };

const FLOOR_ID = "v-78-floor2";
const HALL_ID = "v-78-floor2-area-6";
const leftReference = entranceStairPortals.find(
  (portal) => portal.layoutId === "v-78-floor2-user-stair-library",
);
const EDGE_ID = leftReference.sourceEdgeId;
const SOURCE_POINT = leftReference.position;
const SOURCE_TARGET = entranceStairPortals.find(
  (portal) => portal.layoutId === "v-78-floor1-user-stair-library",
).position;
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
function upperLibraryStairLayoutsForFloor(floor) {
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
    "Вниз к стене главного входа, площадка и разворот на 180°. Показаны стенки и нижняя площадка. Схема по вашему описанию; размеры и высота приблизительные. Нижний вид показан отдельно у существующей точки перехода. Точное совмещение верхнего и нижнего планов не установлено.";
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

const LOWER_AREAS = {
  "v-78-floor1-area-475": {
    kind: "unclassified",
    center: [44.5641, 20.1614],
    points: [
      [40.112, 13.3934],
      [35.559, 14.3884],
      [30.448, 15.9504],
      [31.649, 19.8904],
      [33.996, 27.2324],
      [38.236, 25.9444],
      [42.898, 25.0024],
      [42.452, 21.1334],
      [47.287, 20.4324],
      [52.467, 20.4404],
      [54.808, 20.6234],
      [57.26, 20.9524],
      [58.601, 12.9494],
      [52.361, 12.5984],
      [46.783, 12.7274],
    ],
    holes: [],
  },
  "v-78-floor1-area-480": {
    kind: "unclassified",
    center: [63.0803, 18.4049],
    points: [
      [65.941, 26.8034],
      [69.242, 15.8574],
      [65.897, 14.6604],
      [62.508, 13.6144],
      [58.601, 12.9494],
      [57.26, 20.9524],
      [56.765, 24.9284],
      [56.969, 24.9704],
      [60.085, 25.5214],
      [63.086, 26.2254],
      [64.965, 26.7384],
    ],
    holes: [],
  },
};
function portalPair(layoutId) {
  const upper = entranceStairPortals.find(
    (portal) => portal.layoutId === layoutId,
  );
  const lower = entranceStairPortals.find(
    (portal) =>
      portal.sourceEdgeId === upper.sourceEdgeId &&
      portal.floorId === "v-78-floor1",
  );
  return {
    edgeId: upper.sourceEdgeId,
    sourceId: upper.sourceTransitionId,
    upper: upper.position,
    lower: lower.position,
  };
}
const rightPortal = portalPair("v-78-floor2-user-stair-entrance-right");
const leftPortal = portalPair("v-78-floor2-user-stair-library");

function matchesPortal(floor, portal, lower) {
  return [floor.markers, floor.transitions].every((collection) => {
    if (!Array.isArray(collection)) return false;
    const found = collection.filter((marker) => marker.id === portal.edgeId);
    if (found.length !== 1) return false;
    const marker = found[0];
    return (
      marker.kind === "stairs" &&
      marker.sourceId === portal.sourceId &&
      marker.source === "source-navigation-graph" &&
      marker.confidence === "source-graph" &&
      samePoint(marker.position, lower ? portal.lower : portal.upper) &&
      marker.targetFloorId === (lower ? FLOOR_ID : "v-78-floor1") &&
      samePoint(marker.targetPosition, lower ? portal.upper : portal.lower)
    );
  });
}

function localCompanion(
  floor,
  { id, label, portal, area, wall, right, lower },
) {
  if (!area || !matchesPortal(floor, portal, lower)) return null;
  const direction = wall[1].map((value, i) => value - wall[0][i]);
  const length = Math.hypot(...direction);
  const axisU = direction.map((value) => (value / length) * (right ? -1 : 1));
  let axisV = [-axisU[1], axisU[0]];
  // These are independent local diagrams. Lower portals belong to a narrower
  // source plan: put their ascending flights inside its existing corridor,
  // rather than moving the portal or pretending the two plan frames coincide.
  if (axisV[1] < 0 !== lower) axisV = axisV.map((value) => -value);
  const size = [3.6, right && !lower ? 4.9 : 5.5];
  const center = lower ? portal.lower : portal.upper;
  const anchor = lower ? [0.75, 0.1] : [0.25, 0.1];
  const origin = center.map(
    (value, i) =>
      value - axisU[i] * anchor[0] * size[0] - axisV[i] * anchor[1] * size[1],
  );
  const world = ([u, v]) =>
    origin.map(
      (value, i) => value + axisU[i] * u * size[0] + axisV[i] * v * size[1],
    );
  const footprint = rectangle(0.04, 0.04, 0.96, 0.98);
  if (
    polygonClipping.difference(
      [footprint.map(world)],
      [area.points, ...area.holes],
    ).length
  )
    return null;
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
  const note = lower
    ? "Лестница у главного входа: два марша и площадка с разворотом на 180°. Нижний вид показан у существующей точки перехода внутри исходного коридора, рядом с туалетами. Верхний и нижний планы не совмещены точно; размеры, высота и направление локальной схемы приблизительные."
    : "Правый спуск у главного входа: два марша и площадка с разворотом на 180°, аналогично левому. Схема по вашему описанию; размеры и высота приблизительные. Длина модели уменьшена до границ исходного холла; точное совмещение с нижним планом не установлено.";
  return {
    id,
    campusId: "v-78",
    floorId: floor.id,
    building: null,
    ...(!lower ? { physicalFloor: 2 } : {}),
    label,
    center: [...center],
    geometryCenter: world([0.5, 0.5]),
    focusDirectionLocal: [0.12, 3, -0.2],
    frame: { origin, axisU, axisV, size },
    sourcePolygonIds: [area.id],
    fitAreaId: area.id,
    sourceMarkerIds: [portal.edgeId],
    strictSourceMarkerMatch: true,
    sourcePhotoIds: [],
    sourcePhotos: [],
    shapeSourcePhotoIds: [],
    shapeSourcePhotos: [],
    shape: "user-confirmed-entrance-return-stair",
    layoutMode: "u-return",
    shapeStatus: "user-confirmed-topology-schematic-dimensions",
    shapeReviewStatus: "user-confirmed-schematic",
    geometryStatus: "user-confirmed-schematic",
    geometrySource: "user-description",
    geometryEvidence: "user-description",
    existenceStatus: "user-confirmed-existence",
    dimensionsStatus: "model-assumptions-not-measured",
    placementStatus: "independent-source-portal-local-schematic",
    verticalStatus: "approximate",
    ascentDirectionStatus: lower
      ? "local-corridor-fit-not-measured"
      : "user-confirmed-descent-toward-entrance-wall",
    levelRole: lower ? "lower-departure" : "upper-arrival",
    levelRoleSource: "user-confirmed-entrance-stair-counterpart",
    footprint,
    displayCutout: !lower,
    ...(!lower
      ? { displayCutoutFootprints: [footprint.map((point) => [...point])] }
      : {}),
    enclosureStatus: "user-confirmed-walls-approximate-interior",
    interiorDisplayStatus: "local-stairwell-inside-existing-source-plan",
    // Leave the lower entrance open, rather than placing a full-height wall
    // across the bottom landing. The other three sides enclose the staircase.
    enclosureWalls: footprint.map((point, i) => ({
      from: [...point],
      to:
        lower && i === 0
          ? [0.46, 0.04]
          : [...footprint[(i + 1) % footprint.length]],
      bottomFraction: lower ? 0 : -1,
      topFraction: lower ? 1 : 0,
      thickness: 0.14,
    })),
    flights: lower
      ? [
          flight([0.75, 0.1], [0.75, 0.78], 0, 0.5),
          flight([0.25, 0.78], [0.25, 0.1], 0.5, 1),
        ]
      : [
          flight([0.25, 0.1], [0.25, 0.78], 0, -0.5),
          flight([0.75, 0.78], [0.75, 0.1], -0.5, -1),
        ],
    landings: [
      {
        role: "intermediate",
        points: rectangle(0.04, 0.78, 0.96, 0.98),
        elevationFraction: lower ? 0.5 : -0.5,
        railEdges: [1, 2, 3],
      },
      {
        role: lower ? "arrival-display-only" : "departure",
        points: rectangle(0.04, 0.04, 0.46, 0.1),
        elevationFraction: lower ? 1 : 0,
        railEdges: [],
      },
      {
        role: lower ? "departure" : "arrival-display-only",
        points: rectangle(0.54, 0.04, 0.96, 0.1),
        elevationFraction: lower ? 0 : -1,
        railEdges: [],
      },
      {
        role: "shaft-bottom-display-only",
        points: footprint.map((point) => [...point]),
        elevationFraction: lower ? -0.05 : -1.05,
        railEdges: [],
      },
    ],
    destinationLabel: lower ? "Главный вход · 2 этаж" : "Коридор этажом ниже",
    destinationStatus: "existing-source-portal-independent-plan-placement",
    routingStatus: "display-only-no-source-flight-path",
    evidence: {
      type: "user-confirmed-topology",
      confirmedAt: "2026-11-12",
      description:
        "Слева и справа от главного входа есть одинаковые лестницы с нижними выходами рядом с туалетами и коридором; размеры не обмерены.",
    },
    note,
  };
}

/** Four local views of the two existing entrance transitions. Their graph
 * portals stay unchanged; no geometric pairing or missing corridor is invented.
 */
export function libraryStairLayoutsForFloor(floor) {
  if (
    floor?.campusId !== "v-78" ||
    floor.units !== "meters" ||
    !Array.isArray(floor.polygons)
  )
    return [];
  if (floor.id === FLOOR_ID && floor.level === 2) {
    const left = upperLibraryStairLayoutsForFloor(floor);
    const hall = matchingHall(floor);
    const rightBoundary = [
      [60.303, 33.3444],
      [63.232, 33.9174],
      [61.54, 40.2034],
      [71.465, 43.0334],
      [83.248, 11.0044],
    ];
    const boundaryMatches =
      hall &&
      rightBoundary
        .slice(1)
        .every((b, i) =>
          hall.points.some(
            (a, j) =>
              (samePoint(a, rightBoundary[i]) &&
                samePoint(hall.points[(j + 1) % hall.points.length], b)) ||
              (samePoint(a, b) &&
                samePoint(
                  hall.points[(j + 1) % hall.points.length],
                  rightBoundary[i],
                )),
          ),
        );
    const right =
      boundaryMatches &&
      matchingPlace(
        floor,
        "v-78--floor-2--9yb",
        EXPECTED_PLACES["v-78--floor-2--9yb"],
      )
        ? localCompanion(floor, {
            id: "v-78-floor2-user-stair-entrance-right",
            label: "Спуск справа от главного входа",
            portal: rightPortal,
            area: hall,
            wall: [
              [61.54, 40.2034],
              [71.465, 43.0334],
            ],
            right: true,
            lower: false,
          })
        : null;
    return [...left, ...(right ? [right] : [])];
  }
  if (floor.id !== "v-78-floor1" || floor.level !== 1) return [];
  return [
    {
      id: "v-78-floor1-user-stair-library",
      label: "Лестница к главному входу · слева",
      portal: leftPortal,
      areaId: "v-78-floor1-area-475",
      wall: [
        [38.236, 25.9444],
        [42.898, 25.0024],
      ],
      right: false,
    },
    {
      id: "v-78-floor1-user-stair-entrance-right",
      label: "Лестница к главному входу · справа",
      portal: rightPortal,
      areaId: "v-78-floor1-area-480",
      wall: [
        [56.969, 24.9704],
        [60.085, 25.5214],
      ],
      right: true,
    },
  ]
    .map((spec) =>
      localCompanion(floor, {
        ...spec,
        lower: true,
        area: matchingPlace(floor, spec.areaId, LOWER_AREAS[spec.areaId]),
      }),
    )
    .filter(Boolean);
}
