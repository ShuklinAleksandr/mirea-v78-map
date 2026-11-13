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

// Intersect a right-going line with the actual hall contour, including holes.
// Taking the first boundary prevents extending this local bank across the hall
// to the distant buffet/exterior wall when a nearer wall or recess intervenes.
function nearestRightBoundary(hall, anchor, along, inside, depth, start) {
  const project = (point, axis) =>
    (point[0] - anchor[0]) * axis[0] + (point[1] - anchor[1]) * axis[1];
  const hits = [];
  for (const ring of [hall.points, ...(hall.holes || [])]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      const da = project(a, inside),
        db = project(b, inside);
      if (Math.abs(db - da) < 1e-9) continue;
      const t = (depth - da) / (db - da);
      if (t < 0 || t > 1) continue;
      const point = a.map((value, k) => value + (b[k] - value) * t);
      const across = project(point, along);
      if (across > start + 1e-6) hits.push({ across, point, wall: { a, b } });
    }
  }
  return hits.sort((a, b) => a.across - b.across)[0] || null;
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
  const hallRings = [halls[0].points, ...(halls[0].holes || [])];
  if (
    hallRings.some(
      (ring) =>
        !Array.isArray(ring) ||
        ring.length < 3 ||
        ring.some(
          (point) =>
            !Array.isArray(point) ||
            point.length !== 2 ||
            !point.every(Number.isFinite),
        ),
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
  // Furniture dimensions are schematic: the desk starts after the frames and
  // ends at the dense bank facing the nearby right-hand entrance wall.
  const turnstileDepth = 1.6;
  const deskStart = 0.1,
    deskLength = turnstileDepth - deskStart,
    deskDepth = 0.55,
    deskAcross = -0.6;
  const deskCenter = inner.a.map(
    (value, i) =>
      value +
      innerAlong[i] * deskAcross +
      innerInside[i] * ((deskStart + turnstileDepth) / 2),
  );
  const chairs = [0.4, 1.25].map((depth) =>
    inner.a.map(
      (value, i) => value - innerAlong[i] * 1.65 + innerInside[i] * depth,
    ),
  );
  const bankStart = deskAcross + deskDepth / 2;
  const postWidth = 0.22,
    postDepth = 0.42;
  const boundaryHits = [-postDepth / 2, 0, postDepth / 2].map((offset) =>
    nearestRightBoundary(
      halls[0],
      inner.a,
      innerAlong,
      innerInside,
      turnstileDepth + offset,
      bankStart,
    ),
  );
  // If this local wall disappears, do not silently span the entire main hall.
  if (
    boundaryHits.some(
      (hit) => !hit || hit.across > innerWidth + 3 || hit.across < 1,
    )
  )
    return null;
  const bankEnd = Math.min(...boundaryHits.map((hit) => hit.across)) - 0.012;
  const postSpan = bankEnd - bankStart - postWidth;
  const turnstileCount = Math.max(1, Math.round(postSpan / 0.9));
  const pitch = postSpan / turnstileCount;
  const bankPoint = (across) =>
    inner.a.map(
      (value, i) =>
        value + innerAlong[i] * across + innerInside[i] * turnstileDepth,
    );
  const postCenters = Array.from({ length: turnstileCount + 1 }, (_, i) =>
    bankPoint(bankStart + postWidth / 2 + i * pitch),
  );
  const turnstileCenters = Array.from({ length: turnstileCount }, (_, i) =>
    bankPoint(bankStart + postWidth / 2 + (i + 0.5) * pitch),
  );
  // Security is AFTER the detector line, inside the existing hall. The small
  // source room beside the street doors stays unnamed and receives no opening.
  // Nothing stretches that room or the hall to make decorative furniture fit.
  const hallFurniture = [
    footprint(deskCenter, innerInside, deskLength, deskDepth),
    ...chairs.map((center) => footprint(center, innerAlong, 0.5, 0.5)),
    footprint(
      bankPoint((bankStart + bankEnd) / 2),
      innerAlong,
      bankEnd - bankStart,
      postDepth,
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
      count: turnstileCount,
      depthAfterInnerBoundary: turnstileDepth,
      centers: turnstileCenters,
      postCenters,
      postWidth,
      postDepth,
      pitch,
      start: bankPoint(bankStart),
      end: bankPoint(bankEnd),
      boundary: boundaryHits[1],
      placement: "continuous-bank-from-security-desk-to-nearest-right-wall",
    },
    guard: {
      sourcePolygonId: HALL_ID,
      label: "Охрана",
      center: deskCenter,
      deskCenter,
      deskAlong: innerInside,
      deskLength,
      deskDepth,
      rotationFromDoorBankDegrees: -90,
      chairCenters: chairs,
      placement: "after-detectors-before-turnstiles-left-side-of-hall",
      publicEntrance: false,
    },
  };
}
