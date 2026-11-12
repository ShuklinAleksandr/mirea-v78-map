import polygonClipping from "polygon-clipping";

const FLOOR_ID = "v-78-floor2";
const ENTRANCE_ID = "v-78--floor-2--9yb";
const LEFT_ROOM_ID = "v-78-floor2-area-9";
const HALL_ID = "v-78-floor2-area-6";
const entrancePoints = [
  [43.5, 38.5824],
  [55.565, 39.2074],
  [56.252, 34.9524],
  [43.352, 34.2784],
  [43.359, 35.0964],
];
const leftRoomPoints = [
  [43.5, 38.5824],
  [43.359, 35.0964],
  [39.983, 35.2464],
  [40.085, 38.6734],
];
const sourceDoors = [
  { id: "v-78-floor2-door-422", a: [49.0831, 38.8716], b: [49.9819, 38.9182] },
  { id: "v-78-floor2-door-93", a: [49.7005, 34.6101], b: [50.4994, 34.6519] },
];
const samePoint = (a, b) =>
  Array.isArray(a) &&
  a.length === 2 &&
  a.every(Number.isFinite) &&
  Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.00015;
const exactPolygon = (floor, id, kind, points) => {
  const matches = floor.polygons.filter((polygon) => polygon.id === id);
  if (matches.length !== 1) return null;
  const polygon = matches[0];
  return polygon.kind === kind &&
    polygon.points?.length === points.length &&
    polygon.points.every((point, i) => samePoint(point, points[i])) &&
    Array.isArray(polygon.holes) &&
    polygon.holes.length === 0
    ? polygon
    : null;
};
const front = { a: entrancePoints[0], b: entrancePoints[1] };
const inner = { a: entrancePoints[3], b: entrancePoints[2] };
function footprint(center, along, length, depth) {
  const normal = [-along[1], along[0]];
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([u, v]) =>
    center.map(
      (value, i) =>
        value + (along[i] * u * length) / 2 + (normal[i] * v * depth) / 2,
    ),
  );
}

/** A display-only entrance bank. Counts and furniture dimensions are a compact
 * schematic, not surveyed doors, obstacles, routing nodes or a new room plan. */
export function getEntranceLayout(floor) {
  if (
    floor?.id !== FLOOR_ID ||
    floor.campusId !== "v-78" ||
    floor.level !== 2 ||
    floor.units !== "meters" ||
    !Array.isArray(floor.polygons) ||
    !Array.isArray(floor.doors)
  )
    return null;
  const entrance = exactPolygon(floor, ENTRANCE_ID, "entrance", entrancePoints);
  const leftRoom = exactPolygon(
    floor,
    LEFT_ROOM_ID,
    "unclassified",
    leftRoomPoints,
  );
  const halls = floor.polygons.filter((polygon) => polygon.id === HALL_ID);
  if (
    !entrance ||
    !leftRoom ||
    halls.length !== 1 ||
    halls[0].kind !== "unclassified" ||
    !halls[0].points?.some(
      (point, i, points) =>
        (samePoint(point, inner.a) &&
          samePoint(points[(i + 1) % points.length], inner.b)) ||
        (samePoint(point, inner.b) &&
          samePoint(points[(i + 1) % points.length], inner.a)),
    )
  )
    return null;
  if (
    !sourceDoors.every((expected) => {
      const matches = floor.doors.filter((door) => door.id === expected.id);
      return (
        matches.length === 1 &&
        samePoint(matches[0].a, expected.a) &&
        samePoint(matches[0].b, expected.b) &&
        matches[0].source === "source-svg-door-opening"
      );
    })
  )
    return null;
  const delta = front.b.map((value, i) => value - front.a[i]);
  const width = Math.hypot(...delta);
  const along = delta.map((value) => value / width);
  const inside = [along[1], -along[0]];
  const at = (u, depth) =>
    front.a.map((value, i) => value + along[i] * u * width + inside[i] * depth);
  const innerDelta = inner.b.map((value, i) => value - inner.a[i]);
  const innerWidth = Math.hypot(...innerDelta);
  const innerAlong = innerDelta.map((value) => value / innerWidth);
  const innerInside = [innerAlong[1], -innerAlong[0]];
  const afterFrame = (u, depth) =>
    inner.a.map(
      (value, i) =>
        value + innerAlong[i] * u * innerWidth + innerInside[i] * depth,
    );
  const deskCenter = inner.a.map(
    (value, i) => value - innerAlong[i] * 0.6 + innerInside[i] * 1.6,
  );
  const chairs = [0.8, 2.4].map((depth) =>
    inner.a.map(
      (value, i) => value - innerAlong[i] * 1.65 + innerInside[i] * depth,
    ),
  );
  const turnstileCenters = [0.22, 0.5, 0.78].map((u) => afterFrame(u, 3.2));
  // Security is AFTER the detector line, inside the existing hall. The small
  // source room beside the street doors stays unnamed and receives no opening.
  // Nothing stretches that room or the hall to make decorative furniture fit.
  const hallFurniture = [
    footprint(deskCenter, innerInside, 3, 0.55),
    ...chairs.map((center) => footprint(center, innerAlong, 0.5, 0.5)),
    ...turnstileCenters.map((center) =>
      footprint(center, innerAlong, 1.4, 0.5),
    ),
  ];
  try {
    if (
      hallFurniture.some(
        (points) =>
          polygonClipping.difference(
            [points],
            [halls[0].points, ...(halls[0].holes || [])],
          ).length,
      )
    )
      return null;
  } catch {
    return null;
  }
  return {
    id: "main-entrance-door-bank",
    floorId: FLOOR_ID,
    sourcePolygonIds: [ENTRANCE_ID, LEFT_ROOM_ID, HALL_ID],
    sourceDoorIds: sourceDoors.map((door) => door.id),
    openSegments: [front, inner],
    front,
    inner,
    width,
    along,
    inside,
    innerWidth,
    innerAlong,
    innerInside,
    evidence: { type: "user-confirmed-entrance-sequence", date: "2026-11-12" },
    approximate: true,
    countStatus: "representative-display-count-not-surveyed",
    dimensionsStatus: "schematic-furniture-inside-source-boundary",
    routingStatus: "display-only-source-graph-unchanged",
    sequence: ["doors", "detectors", "turnstiles", "hall"],
    doors: {
      count: 5,
      leaves: 2,
      depth: 0.1,
      centers: Array.from({ length: 5 }, (_, i) => at((i + 0.5) / 5, 0.1)),
    },
    detectors: {
      count: 3,
      depthAfterInnerBoundary: 0,
      centers: [0.22, 0.5, 0.78].map((u) => afterFrame(u, 0)),
      opening: 1.35,
    },
    turnstiles: {
      count: 3,
      depthAfterInnerBoundary: 3.2,
      centers: turnstileCenters,
    },
    guard: {
      sourcePolygonId: HALL_ID,
      label: "Охрана",
      center: deskCenter,
      deskCenter,
      deskAlong: innerInside,
      deskLength: 3,
      deskDepth: 0.55,
      rotationFromDoorBankDegrees: -90,
      chairCenters: chairs,
      placement: "after-detectors-before-turnstiles-left-side-of-hall",
      publicEntrance: false,
    },
  };
}
