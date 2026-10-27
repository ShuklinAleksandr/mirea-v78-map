// Display corrections for the user-confirmed open transverse partitions in
// building A's main corridor. Endpoints are exact shared boundaries of the
// two listed unnamed circulation regions, not a general corridor/door filter.
const partitions = [
  [1, 153, [-45.689, 15.2104], [-46.728, 12.0794], [4, 109]],
  [1, 167, [66.914, -11.6546], [66.179, -9.4796], [68, 181]],
  [1, 173, [-97.617, 32.8544], [-98.833, 29.6984], [178, 77]],
  [1, 187, [-82.961, 27.6204], [-84.051, 24.4854], [77, 4]],
  [2, 30, [102.235, -6.1406], [99.621, 0.5724], [29, 24]],
  [2, 33, [3.463, -2.3156], [1.168, -9.1496], [56, 24]],
  [3, 2, [188.922, 21.1664], [186.993, 26.6624], [8, 48]],
  [3, 6, [0.018, -5.1626], [-0.977, -8.0666], [34, 39]],
  [3, 14, [-89.377, 27.6954], [-91.192, 22.1224], [43, 35]],
  [3, 23, [19.343, -11.6706], [18.267, -14.6386], [39, 5]],
  [3, 31, [169.642, 13.8834], [168.304, 17.9624], [48, 13]],
  [3, 32, [-84.765, 22.3194], [-85.69, 19.3794], [35, 34]],
  [3, 56, [98.351, -8.4426], [97.364, -5.4386], [13, 5]],
  [4, 2, [199.892, 33.0964], [198.869, 35.6304], [34, 0]],
  [4, 27, [189.512, 25.1584], [187.193, 31.5144], [0, 2]],
];

export const OPEN_CORRIDOR_PARTITIONS = partitions.map(
  ([level, door, a, b, areas]) => ({
    id: `A${level}-open-corridor-${door}`,
    floorId: `v-78-floor${level}`,
    building: "А",
    doorId: `v-78-floor${level}-door-${door}`,
    sourceAreaIds: areas.map((area) => `v-78-floor${level}-area-${area}`),
    a,
    b,
    evidence: { type: "user-confirmed-open-corridor", date: "2026-10-20" },
  }),
);

// These two source cells stand on either side of the main stair. The user
// identified them as open buffet areas on 2026-10-25, not enclosed dining rooms.
// Only their boundary with A's corridor is open. The latest clarification
// retains the walls toward both the neighbouring classrooms and entrance hall.
export const OPEN_HALL_BUFFETS = [
  {
    id: "A2-open-buffet-west",
    floorId: "v-78-floor2",
    polygonId: "v-78--floor-2--9z2",
    openAreaIds: ["v-78-floor2-area-24"],
    furnitureRotation: 90,
    points: [
      [22.744, -8.4786],
      [25.393, -0.5946],
      [36.979, -4.1706],
      [35.281, -9.3526],
      [28.549, -10.6066],
    ],
  },
  {
    id: "A2-open-buffet-east",
    floorId: "v-78-floor2",
    polygonId: "v-78--floor-2--a05",
    openAreaIds: ["v-78-floor2-area-24"],
    furnitureRotation: -90,
    points: [
      [77.127, 1.0004],
      [79.843, -6.8506],
      [74.248, -8.8986],
      [67.343, -9.0996],
      [65.195, -3.1856],
    ],
  },
].map((entry) => ({
  ...entry,
  evidence: { type: "user-confirmed-open-buffet", date: "2026-10-25" },
}));

// The shared boundary between the entrance hall and A's circulation area.
// Endpoints follow the existing curved source boundary, not a new opening
// drawn across a room or across the exterior facade.
export const OPEN_HALL_PASSAGE = {
  id: "A2-open-hall-to-A-doors",
  floorId: "v-78-floor2",
  sourceAreaIds: ["v-78-floor2-area-6", "v-78-floor2-area-24"],
  doorId: "v-78-floor2-door-90",
  points: [
    [39.782, -4.8726],
    [41.48, -5.2226],
    [43.735, -5.6876],
    [47.563, -6.1426],
    [50.041, -6.1296],
    [54.43, -5.8626],
    [59.097, -5.1516],
    [62.41, -4.0836],
  ],
  evidence: { type: "user-confirmed-open-doors", date: "2026-10-25" },
  doorGroup: {
    count: 4,
    leavesPerDoor: 2,
    userConfirmedCount: true,
    rendering: "open-passages-only",
    evidence: { type: "user-confirmed-door-count", date: "2026-10-25" },
  },
};

const tolerance = 0.005;
const epsilon = 1e-7;
function spanCoordinates(point, opening) {
  const dx = opening.b[0] - opening.a[0],
    dz = opening.b[1] - opening.a[1];
  const length = Math.hypot(dx, dz);
  const x = point[0] - opening.a[0],
    z = point[1] - opening.a[1];
  return {
    along: (x * dx + z * dz) / length,
    across: (x * dz - z * dx) / length,
    length,
  };
}

function onOpening(segment, opening) {
  return [segment.a, segment.b].every((point) => {
    const { along, across, length } = spanCoordinates(point, opening);
    return (
      Math.abs(across) <= tolerance &&
      along >= -tolerance &&
      along <= length + tolerance
    );
  });
}

function subtractOpening(segment, opening) {
  const a = spanCoordinates(segment.a, opening),
    b = spanCoordinates(segment.b, opening);
  if (
    Math.abs(a.across) > tolerance ||
    Math.abs(b.across) > tolerance ||
    Math.min(a.along, b.along) >= a.length - epsilon ||
    Math.max(a.along, b.along) <= epsilon
  )
    return [segment];
  const delta = b.along - a.along;
  if (Math.abs(delta) < epsilon) return [segment];
  const t0 = Math.max(
    0,
    Math.min((0 - a.along) / delta, (a.length - a.along) / delta),
  );
  const t1 = Math.min(
    1,
    Math.max((0 - a.along) / delta, (a.length - a.along) / delta),
  );
  if (t1 - t0 < epsilon) return [segment];
  const point = (t) =>
    segment.a.map((value, i) => value + (segment.b[i] - value) * t);
  const parts = [];
  if (t0 > epsilon) parts.push({ ...segment, b: point(t0) });
  if (t1 < 1 - epsilon) parts.push({ ...segment, a: point(t1) });
  return parts;
}

const samePoint = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.0001;
const boundarySegments = (points, close = false) =>
  points
    .slice(0, close ? undefined : -1)
    .map((a, i) => ({ a, b: points[(i + 1) % points.length] }));
const hasSourceEdge = (polygon, segment) =>
  boundarySegments(polygon.points || [], true).some(
    (edge) =>
      (samePoint(edge.a, segment.a) && samePoint(edge.b, segment.b)) ||
      (samePoint(edge.a, segment.b) && samePoint(edge.b, segment.a)),
  );

/** Only exact source identities and contours receive a user display correction. */
export function getConfirmedHallDisplay(floor) {
  if (floor.id !== "v-78-floor2") return { buffets: [], passage: null };
  const buffets = OPEN_HALL_BUFFETS.filter((entry) =>
    floor.polygons?.some(
      (polygon) =>
        polygon.id === entry.polygonId &&
        polygon.kind === "cafeteria" &&
        polygon.points?.length === entry.points.length &&
        polygon.points.every((point, i) => samePoint(point, entry.points[i])),
    ),
  ).map((entry) => ({
    ...entry,
    openSegments: boundarySegments(entry.points, true).filter((segment) =>
      entry.openAreaIds.some((id) =>
        floor.polygons?.some(
          (polygon) =>
            polygon.id === id &&
            polygon.kind === "unclassified" &&
            !polygon.label &&
            hasSourceEdge(polygon, segment),
        ),
      ),
    ),
  }));
  const segments = boundarySegments(OPEN_HALL_PASSAGE.points);
  const passage =
    OPEN_HALL_PASSAGE.sourceAreaIds.every((id) =>
      floor.polygons?.some(
        (polygon) =>
          polygon.id === id &&
          polygon.kind === "unclassified" &&
          segments.every((segment) => hasSourceEdge(polygon, segment)),
      ),
    ) &&
    floor.doors?.some(
      (door) =>
        door.id === OPEN_HALL_PASSAGE.doorId &&
        segments.some((segment) => onOpening(door, segment)),
    )
      ? OPEN_HALL_PASSAGE
      : null;
  return { buffets, passage };
}

/** Return a rendering view only. Source floor, room polygons and routing stay intact. */
export function getIndoorDisplayGeometry(floor) {
  const applicable = OPEN_CORRIDOR_PARTITIONS.filter(
    (opening) =>
      opening.floorId === floor.id &&
      opening.sourceAreaIds.every((id) =>
        floor.polygons?.some((p) => p.id === id && p.kind === "unclassified"),
      ) &&
      floor.doors?.some(
        (door) => door.id === opening.doorId && onOpening(door, opening),
      ),
  );
  const hall = getConfirmedHallDisplay(floor);
  if (!applicable.length && !hall.buffets.length && !hall.passage)
    return {
      walls: floor.walls || [],
      doors: floor.doors || [],
      appliedOverrides: [],
      openDoors: [],
      doorGroup: null,
    };
  const hallSegments = [
    ...hall.buffets.flatMap((entry) => entry.openSegments),
    ...(hall.passage ? boundarySegments(hall.passage.points) : []),
  ];
  let walls = floor.walls || [];
  for (const opening of [...applicable, ...hallSegments])
    walls = walls.flatMap((wall) => subtractOpening(wall, opening));
  const hiddenDoors = new Set(applicable.map((opening) => opening.doorId));
  for (const door of floor.doors || [])
    if (hallSegments.some((segment) => onOpening(door, segment)))
      hiddenDoors.add(door.id);
  return {
    walls,
    doors: (floor.doors || []).filter((door) => !hiddenDoors.has(door.id)),
    appliedOverrides: [
      ...applicable.map((opening) => opening.id),
      ...hall.buffets.map((entry) => entry.id),
      ...(hall.passage ? [hall.passage.id] : []),
    ],
    // Retain the source opening as evidence; it is not the rendered module count.
    openDoors: hall.passage
      ? (floor.doors || [])
          .filter((door) => door.id === hall.passage.doorId)
          .map((door) => ({ ...door, evidence: hall.passage.evidence }))
      : [],
    doorGroup: hall.passage
      ? {
          ...hall.passage.doorGroup,
          id: hall.passage.id,
          sourceDoorId: hall.passage.doorId,
          points: hall.passage.points,
        }
      : null,
  };
}
