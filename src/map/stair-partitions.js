import registry from "../../public/data/stair-layouts.json" with { type: "json" };

// Explicit source identities for the wide ЛК2 family with two side doors.
// First-floor G/V containers extend into the corridor and have no matching
// front boundary here. Compact cells and the main hall stair are not covered.
const sources = [
  [
    "v78-Г-1-ЛК2",
    "v-78-floor1-area-307",
    [-4.075, -28.8671],
    [-8.5765, -27.2389],
    ["v-78-floor1-door-31", "v-78-floor1-door-337"],
    "42d747c8",
  ],
  [
    "v78-Г-2-ЛК2",
    "v-78-floor2-area-201",
    [-8.5065, -27.0393],
    [-4.0718, -28.6301],
    ["v-78-floor2-door-227", "v-78-floor2-door-211"],
    "22f099cc",
  ],
  [
    "v78-Г-3-ЛК2",
    "v-78-floor3-area-173",
    [-8.5603, -26.9328],
    [-3.8736, -28.6038],
    ["v-78-floor3-door-189", "v-78-floor3-door-160"],
    "c6bec56c",
  ],
  [
    "v78-В-1-ЛК2",
    "v-78-floor1-area-259",
    [97.5082, -29.7299],
    [102.0465, -27.9297],
    ["v-78-floor1-door-299", "v-78-floor1-door-298"],
    "795f8ffd",
  ],
  [
    "v78-В-2-ЛК2",
    "v-78-floor2-area-184",
    [102.3879, -27.6162],
    [97.6379, -29.5207],
    ["v-78-floor2-door-193", "v-78-floor2-door-174"],
    "c31791cc",
  ],
  [
    "v78-В-3-ЛК2",
    "v-78-floor3-area-159",
    [102.4744, -27.6423],
    [97.7764, -29.5405],
    ["v-78-floor3-door-135", "v-78-floor3-door-119"],
    "22cf5c66",
  ],
  [
    "v78-Б-1-ЛК2",
    "v-78-floor1-area-229",
    [167.634, -2.4418],
    [172.2939, -0.7606],
    ["v-78-floor1-door-7", "v-78-floor1-door-269"],
    "b538b545",
  ],
  [
    "v78-Б-2-ЛК2",
    "v-78-floor2-area-98",
    [167.3729, -2.7804],
    [172.369, -0.8955],
    ["v-78-floor2-door-135", "v-78-floor2-door-139"],
    "3d788be2",
  ],
  [
    "v78-Б-3-ЛК2",
    "v-78-floor3-area-105",
    [167.8995, -2.6318],
    [172.4046, -0.9566],
    ["v-78-floor3-door-112", "v-78-floor3-door-86"],
    "df708d3d",
  ],
];

export const STAIR_PARTITION_MODEL = Object.freeze({
  maximumWidth: 2,
  widthFraction: 0.25,
  minimumSidePassage: 1.4,
  innerV: 0.7,
  innerFlightClearance: 0.05,
  innerThickness: 0.2,
});

const finitePoint = (point) =>
  Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);
const samePoint = (a, b) =>
  finitePoint(a) && finitePoint(b) && a.every((value, i) => value === b[i]);
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function insideRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j],
      b = ring[i];
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

function innerStartWall(layout, polygon) {
  // The two parallel flights end/start at v=.7. Leave a .05-cell buffer
  // beyond each flight edge, so the divider cannot close either side branch.
  const flights = layout.flights || [];
  if (
    flights.length !== 2 ||
    !flights.every(
      (flight) =>
        finitePoint(flight.from) &&
        finitePoint(flight.to) &&
        Number.isFinite(flight.widthFraction) &&
        Math.abs(flight.from[0] - flight.to[0]) < 0.0001 &&
        [flight.from, flight.to].some(
          (point) => Math.abs(point[1] - STAIR_PARTITION_MODEL.innerV) < 0.0001,
        ),
    )
  )
    return { wall: null, status: "skipped-unmatched-flight-starts" };
  const ordered = [...flights].sort((a, b) => a.from[0] - b.from[0]);
  const u0 =
    ordered[0].from[0] +
    ordered[0].widthFraction / 2 +
    STAIR_PARTITION_MODEL.innerFlightClearance;
  const u1 =
    ordered[1].from[0] -
    ordered[1].widthFraction / 2 -
    STAIR_PARTITION_MODEL.innerFlightClearance;
  if (u1 <= u0)
    return { wall: null, status: "skipped-no-space-between-flights" };
  const frame = layout.frame;
  const world = ([u, v]) => [
    frame.origin[0] +
      frame.axisU[0] * u * frame.size[0] +
      frame.axisV[0] * v * frame.size[1],
    frame.origin[1] +
      frame.axisU[1] * u * frame.size[0] +
      frame.axisV[1] * v * frame.size[1],
  ];
  const local = {
    a: [u0, STAIR_PARTITION_MODEL.innerV],
    b: [u1, STAIR_PARTITION_MODEL.innerV],
  };
  const a = world(local.a),
    b = world(local.b);
  const length = distance(a, b),
    half = STAIR_PARTITION_MODEL.innerThickness / 2;
  const normal = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
  const wallPoints = [
    [a[0] + normal[0] * half, a[1] + normal[1] * half],
    [b[0] + normal[0] * half, b[1] + normal[1] * half],
    [b[0] - normal[0] * half, b[1] - normal[1] * half],
    [a[0] - normal[0] * half, a[1] - normal[1] * half],
  ];
  // The fingerprint fixes these nine source polygons. Sample both long faces
  // as well as the end caps; reject a divider outside the known cell/hole.
  const contained = (point) =>
    insideRing(point, polygon.points) &&
    !(polygon.holes || []).some((hole) => insideRing(point, hole));
  for (const sign of [-1, 0, 1])
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      if (
        !contained([
          a[0] + (b[0] - a[0]) * t + normal[0] * half * sign,
          a[1] + (b[1] - a[1]) * t + normal[1] * half * sign,
        ])
      )
        return { wall: null, status: "skipped-outside-source-cell" };
    }
  return {
    status: "shown",
    wall: {
      a,
      b,
      width: STAIR_PARTITION_MODEL.innerThickness,
      source: "user-description",
      confidence: "user-confirmed-approximate-dimensions",
      local,
      wallPoints,
      displayEvidence: {
        type: "user-confirmed-inner-start-divider",
        date: "2026-10-25",
        dimensionsStatus: "schematic-not-measured",
        referenceLayoutId: "v78-Г-2-ЛК2",
      },
    },
  };
}

// This is an exact-input change detector, not a security boundary. A changed
// source polygon, frame, door endpoint or wall fails closed pending review.
function fingerprint(value) {
  let hash = 2166136261;
  for (const character of JSON.stringify(value))
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function shortenPartition(layout, wall, doors) {
  const length = distance(wall.a, wall.b);
  if (!Number.isFinite(length) || length < 0.1) return null;
  const direction = [
    (wall.b[0] - wall.a[0]) / length,
    (wall.b[1] - wall.a[1]) / length,
  ];
  // Label left/right by the cell's axisU, independent of source wall winding.
  if (
    direction[0] * layout.frame.axisU[0] +
      direction[1] * layout.frame.axisU[1] <
    0
  ) {
    direction[0] *= -1;
    direction[1] *= -1;
  }
  const center = [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2];
  const coordinates = (point) => {
    const x = point[0] - center[0],
      z = point[1] - center[1];
    return {
      along: x * direction[0] + z * direction[1],
      across: x * direction[1] - z * direction[0],
    };
  };
  const spans = doors
    .map((door) => {
      const points = [coordinates(door.a), coordinates(door.b)];
      return {
        min: Math.min(...points.map((point) => point.along)),
        max: Math.max(...points.map((point) => point.along)),
        offset: Math.max(...points.map((point) => Math.abs(point.across))),
      };
    })
    .sort((a, b) => a.min - b.min);
  const [left, right] = spans;
  if (
    !left ||
    !right ||
    spans.some((span) => span.offset > 0.004) ||
    Math.abs(left.max + length / 2) > 0.004 ||
    Math.abs(right.min - length / 2) > 0.004
  )
    return null;
  const width = Math.min(
    STAIR_PARTITION_MODEL.maximumWidth,
    layout.frame.size[0] * STAIR_PARTITION_MODEL.widthFraction,
    length,
    2 * (-left.min - STAIR_PARTITION_MODEL.minimumSidePassage),
    2 * (right.max - STAIR_PARTITION_MODEL.minimumSidePassage),
  );
  if (!Number.isFinite(width) || width < 0.2 || width > length - 0.005)
    return null;
  const pointAt = (offset) => [
    center[0] + direction[0] * offset,
    center[1] + direction[1] * offset,
  ];
  const segment = { a: pointAt(-width / 2), b: pointAt(width / 2) };
  return {
    segment,
    width,
    leftClearance: -width / 2 - left.min,
    rightClearance: right.max - width / 2,
  };
}

/** Display-only short front wall and a separate divider between flight starts.
 * Source doors and graph stay intact; routing restrictions are handled separately. */
export function getStairPartitionView(floor, layouts = registry.layouts) {
  const originalWalls = floor?.walls || [];
  const unchanged = { walls: originalWalls, partitions: [] };
  if (floor?.campusId !== "v-78" || !Array.isArray(layouts)) return unchanged;
  const replacements = new Map();
  const additions = [];
  const partitions = [];
  for (const [layoutId, polygonId, a, b, doorIds, expected] of sources) {
    const layout = layouts.find((candidate) => candidate.id === layoutId);
    if (
      layout?.floorId !== floor.id ||
      layout.shape !== "wide-well-U" ||
      !["Г", "В", "Б"].includes(layout.building) ||
      layout.fitAreaId !== polygonId ||
      !layout.sourcePolygonIds?.includes(polygonId)
    )
      continue;
    const polygon = floor.polygons?.find(
      (candidate) => candidate.id === polygonId,
    );
    const wallIndex = originalWalls.findIndex(
      (wall) => samePoint(wall.a, a) && samePoint(wall.b, b),
    );
    const wall = originalWalls[wallIndex];
    const doors = doorIds.map((id) =>
      floor.doors?.find((door) => door.id === id),
    );
    if (!polygon || !wall || doors.some((door) => !door)) continue;
    if (
      fingerprint({
        polygon: { points: polygon.points, holes: polygon.holes || [] },
        frame: layout.frame,
        wall: { a: wall.a, b: wall.b },
        doors: doors.map(({ id, a, b }) => ({ id, a, b })),
      }) !== expected
    )
      continue;
    const correction = shortenPartition(layout, wall, doors);
    if (!correction) continue;
    const inner = innerStartWall(layout, polygon);
    if (inner.wall) additions.push(inner.wall);
    const evidence = {
      type: "user-confirmed-short-stair-partition",
      date: "2026-10-25",
      dimensionsStatus: "schematic-not-measured",
      referenceLayoutId: "v78-Г-2-ЛК2",
    };
    replacements.set(wallIndex, {
      ...wall,
      ...correction.segment,
      displayEvidence: evidence,
    });
    partitions.push({
      id: `stair-partition:${layout.id}`,
      layoutId: layout.id,
      floorId: floor.id,
      building: layout.building,
      polygonId,
      sourceWallIndex: wallIndex,
      sourceSegment: { a: wall.a, b: wall.b },
      sourceDoorIds: doorIds,
      ...correction,
      innerWall: inner.wall,
      innerWallStatus: inner.status,
      evidence,
      routingEffect:
        "source-door-anchors-preserved-runtime-conflicts-filtered-separately",
    });
  }
  return replacements.size
    ? {
        walls: [
          ...originalWalls.map((wall, i) => replacements.get(i) || wall),
          ...additions,
        ],
        partitions,
      }
    : unchanged;
}
