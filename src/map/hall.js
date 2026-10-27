import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  getConfirmedHallDisplay,
  getIndoorDisplayGeometry,
} from "./indoor-overrides.js";

const wallMaterial = (color, options = {}) =>
  new THREE.MeshStandardMaterial({
    color,
    roughness: 0.86,
    ...options,
  });

function shape(polygon) {
  const result = new THREE.Shape(
    polygon.points.map(([x, z]) => new THREE.Vector2(x, -z)),
  );
  for (const hole of polygon.holes || []) {
    result.holes.push(
      new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, -z))),
    );
  }
  return result;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

function distanceToSegment(point, a, b) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / (dx * dx + dz * dz),
    ),
  );
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dz);
}

function normalAwayFromPolygon(a, b, polygon) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    length = Math.hypot(dx, dz);
  if (!length) return [0, 1];
  let nx = -dz / length,
    nz = dx / length;
  const center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (
    pointInRing([center[0] + nx * 0.12, center[1] + nz * 0.12], polygon.points)
  ) {
    nx *= -1;
    nz *= -1;
  }
  return [nx, nz];
}

function quad(a, b, base, top, normal, offset = 0) {
  const ax = a[0] + normal[0] * offset,
    az = a[1] + normal[1] * offset;
  const bx = b[0] + normal[0] * offset,
    bz = b[1] + normal[1] * offset;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        ax,
        base,
        az,
        bx,
        base,
        bz,
        bx,
        top,
        bz,
        ax,
        base,
        az,
        bx,
        top,
        bz,
        ax,
        top,
        az,
      ],
      3,
    ),
  );
  geometry.computeVertexNormals();
  return geometry;
}

function boxOnSegment(a, b, y, height, depth, normal, offset = 0, width) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const geometry = new THREE.BoxGeometry(
    width ?? length,
    height,
    depth,
  ).toNonIndexed();
  geometry.rotateY(-Math.atan2(b[1] - a[1], b[0] - a[0]));
  geometry.translate(
    (a[0] + b[0]) / 2 + normal[0] * offset,
    y,
    (a[1] + b[1]) / 2 + normal[1] * offset,
  );
  return geometry;
}

function addBatch(
  group,
  geometries,
  mat,
  name,
  hall,
  { castShadow = true, receiveShadow = true } = {},
) {
  if (!geometries.length) {
    mat.dispose();
    return null;
  }
  // Only position and normal are required by these untextured materials.
  for (const geometry of geometries) {
    for (const key of Object.keys(geometry.attributes)) {
      if (!["position", "normal"].includes(key)) geometry.deleteAttribute(key);
    }
  }
  const geometry = mergeGeometries(geometries);
  geometries.forEach((item) => item.dispose());
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  mesh.userData = {
    exteriorFeature: hall.id,
    approximate: true,
    geometryStatus: hall.status || "photo-informed-approximation",
    sourcePolygonIds: hall.sourcePolygonIds || [],
  };
  group.add(mesh);
  return mesh;
}

/**
 * The wide entrance pavilion is separate from the source interiors.
 * Remove hall.replaceShellOverrideIds from the generic exterior first.
 * Dimensions and decorative subdivisions are schematic; the source contour is retained.
 */
export function createEntranceHall(hall) {
  const group = new THREE.Group();
  group.name = "Главный вход — объём по плану, оформление по фото";
  if (!hall?.lowPolygon?.points?.length) return { group, pickables: [] };
  group.userData = {
    exteriorFeature: hall.id,
    approximate: true,
    geometryStatus: hall.status,
  };

  const base = hall.base || 0,
    top = hall.height || 5;
  const walls = [],
    roofs = [],
    glazing = [],
    frames = [],
    darkBands = [],
    highWall = [];
  const bodyPolygons = hall.volumePolygons?.length
    ? hall.volumePolygons
    : [hall.lowPolygon];
  // Vertical faces only: there is exactly one roof, built below from roofPolygons.
  for (const polygon of bodyPolygons) {
    for (const ring of [polygon.points, ...(polygon.holes || [])]) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i],
          b = ring[(i + 1) % ring.length];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.01) continue;
        walls.push(quad(a, b, base, top, normalAwayFromPolygon(a, b, polygon)));
      }
    }
  }
  for (const polygon of hall.roofPolygons || [hall.lowPolygon]) {
    const geometry = new THREE.ShapeGeometry(shape(polygon)).toNonIndexed();
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, hall.roof?.height ?? top, 0);
    roofs.push(geometry);
  }

  for (const segment of hall.frontGlazingSegments || []) {
    const { a, b } = segment;
    const normal = normalAwayFromPolygon(a, b, hall.lowPolygon);
    const low = segment.base ?? base + 0.25,
      high = segment.top ?? top - 0.85;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    glazing.push(quad(a, b, low, high, normal, 0.08));
    // Mullion count is a display subdivision, not a claim about the actual glazing.
    const divisions = Math.max(1, Math.round(length / 2.2));
    for (let i = 0; i <= divisions; i++) {
      const t = i / divisions,
        point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      frames.push(
        boxOnSegment(
          point,
          [point[0] + b[0] - a[0], point[1] + b[1] - a[1]],
          (low + high) / 2,
          high - low,
          0.08,
          normal,
          0.13,
          0.06,
        ).translate(-(b[0] - a[0]) / 2, 0, -(b[1] - a[1]) / 2),
      );
    }
    frames.push(boxOnSegment(a, b, low + 0.06, 0.12, 0.1, normal, 0.12));
    frames.push(boxOnSegment(a, b, high - 0.04, 0.08, 0.1, normal, 0.12));
    darkBands.push(
      quad(a, b, high, top + (hall.roof?.parapetHeight || 0.25), normal, 0.09),
    );
  }

  // Doors follow the known entrance edge. Their division is deliberately schematic.
  if (hall.entranceFrontSegment) {
    const { a, b } = hall.entranceFrontSegment;
    const normal = normalAwayFromPolygon(a, b, hall.lowPolygon);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const doorCount = Math.max(2, Math.round(length / 2.4));
    for (let i = 0; i < doorCount; i++) {
      const left = (i + 0.12) / doorCount,
        right = (i + 0.88) / doorCount;
      const da = [a[0] + (b[0] - a[0]) * left, a[1] + (b[1] - a[1]) * left];
      const db = [a[0] + (b[0] - a[0]) * right, a[1] + (b[1] - a[1]) * right];
      darkBands.push(quad(da, db, base + 0.06, base + 2.8, normal, 0.15));
      frames.push(boxOnSegment(da, db, base + 2.8, 0.09, 0.08, normal, 0.2));
    }
  }

  if (hall.canopy?.points?.length > 2) {
    const canopy = hall.canopy;
    const geometry = new THREE.ExtrudeGeometry(shape(canopy), {
      depth: canopy.height ?? 0.4,
      bevelEnabled: false,
      curveSegments: 1,
    });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, canopy.base ?? top - 0.55, 0);
    darkBands.push(geometry);
  }
  // The rear boundary of the low pavilion can lie inside the upper A envelope.
  // Prefer its actual visible facade edges, derived from exterior height bands.
  for (const segment of hall.visibleTopWallSegments ||
    hall.topWallSegments ||
    []) {
    let normal = segment.outwardNormal?.slice();
    if (!normal) {
      normal = normalAwayFromPolygon(segment.a, segment.b, hall.lowPolygon);
      normal[0] *= -1;
      normal[1] *= -1;
    }
    highWall.push(
      quad(
        segment.a,
        segment.b,
        segment.base ?? top,
        segment.top ?? 18,
        normal,
        0.08,
      ),
    );
  }

  const surfaces = [
    addBatch(
      group,
      walls,
      wallMaterial(0xe2e1d5, { side: THREE.DoubleSide }),
      "Вестибюль · стены",
      hall,
    ),
    addBatch(
      group,
      roofs,
      wallMaterial(0x899797),
      "Вестибюль · единая плоская кровля",
      hall,
    ),
    addBatch(
      group,
      glazing,
      wallMaterial(0x607b7b, {
        metalness: 0.13,
        roughness: 0.37,
        side: THREE.DoubleSide,
      }),
      "Вестибюль · витраж",
      hall,
      { castShadow: false },
    ),
    addBatch(
      group,
      frames,
      wallMaterial(0xd6d7c8),
      "Вестибюль · стойки",
      hall,
      { castShadow: false },
    ),
    addBatch(
      group,
      darkBands,
      wallMaterial(0x4e5b5e, { side: THREE.DoubleSide }),
      "Вестибюль · фасция и козырёк",
      hall,
    ),
    addBatch(
      group,
      highWall,
      wallMaterial(0xdcded3, { side: THREE.DoubleSide }),
      "А · глухой фасад за входом",
      hall,
      // The underlying source envelope is almost parallel to this facing.
      // Avoid shadow-map acne on the blank wall without changing other surfaces.
      { receiveShadow: false },
    ),
  ];
  return { group, pickables: surfaces.filter(Boolean) };
}

/** Decorative, explicitly approximate furniture inside the confirmed open areas.
 * These objects do not create room contours, obstacles or routing connections.
 */
export function createIndoorHallDetails(
  floor,
  display = getIndoorDisplayGeometry(floor),
) {
  const group = new THREE.Group();
  group.name = "Главный холл · открытые проходы и буфеты";
  group.userData = {
    approximate: true,
    evidence: { type: "user-confirmed", date: "2026-10-25" },
    furnitureStatus: "schematic-arrangement-not-surveyed",
    buffets: [],
  };
  const buffets = getConfirmedHallDisplay(floor).buffets;
  const tableTops = [],
    counterTops = [],
    supports = [];
  for (const buffet of buffets) {
    const polygon = floor.polygons.find((p) => p.id === buffet.polygonId);
    const center = polygon.center;
    const longest = buffet.points
      .map((a, i) => ({ a, b: buffet.points[(i + 1) % buffet.points.length] }))
      .sort(
        (a, b) =>
          Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1]) -
          Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1]),
      )[0];
    const length = Math.hypot(
      longest.b[0] - longest.a[0],
      longest.b[1] - longest.a[1],
    );
    const originalAlong = [
      (longest.b[0] - longest.a[0]) / length,
      (longest.b[1] - longest.a[1]) / length,
    ];
    const originalInside = normalAwayFromPolygon(
      longest.a,
      longest.b,
      polygon,
    ).map((value) => -value);
    const radians = (buffet.furnitureRotation * Math.PI) / 180;
    // Clockwise/counterclockwise refer to the top-down source x/z plan.
    const rotate = ([x, z]) => [
      x * Math.cos(radians) - z * Math.sin(radians),
      x * Math.sin(radians) + z * Math.cos(radians),
    ];
    const along = rotate(originalAlong),
      inside = rotate(originalInside);
    // Rotate the former layout around its own source centre, leaving the
    // source buffet region, classrooms and circulation contours stationary.
    const counterOffset = rotate(
      longest.a.map(
        (value, i) =>
          (value + longest.b[i]) / 2 + originalInside[i] * 1.15 - center[i],
      ),
    );
    const counterCenter = center.map((value, i) => value + counterOffset[i]);
    const counterLength = Math.min(4.8, length * 0.55);
    const counterA = counterCenter.map(
      (value, i) => value - (along[i] * counterLength) / 2,
    );
    const counterB = counterCenter.map(
      (value, i) => value + (along[i] * counterLength) / 2,
    );
    supports.push(boxOnSegment(counterA, counterB, 0.52, 0.78, 0.75, [0, 0]));
    counterTops.push(boxOnSegment(counterA, counterB, 0.95, 0.12, 0.9, [0, 0]));
    const tableRadius = 0.55,
      tableCenters = [];
    // Six schematic tables, with their whole tops inside the source buffet.
    // A strip beside the open circulation boundary and a gap at the counter
    // remain free in this drawing. These clearances are not surveyed widths.
    for (const [step, across] of [-1.8, 0, 1.8].flatMap((step) =>
      [-0.3, 2].map((across) => [step, across]),
    )) {
      const point = center.map(
        (value, i) => value + along[i] * step + inside[i] * across,
      );
      const counterDelta = point.map((value, i) => value - counterCenter[i]);
      const counterDistance = Math.hypot(
        Math.max(
          0,
          Math.abs(counterDelta[0] * along[0] + counterDelta[1] * along[1]) -
            counterLength / 2,
        ),
        Math.max(
          0,
          Math.abs(counterDelta[0] * inside[0] + counterDelta[1] * inside[1]) -
            0.45,
        ),
      );
      if (
        !pointInRing(point, polygon.points) ||
        !polygon.points.every(
          (a, i) =>
            distanceToSegment(
              point,
              a,
              polygon.points[(i + 1) % polygon.points.length],
            ) >=
            tableRadius + 0.75,
        ) ||
        counterDistance < tableRadius + 0.9 ||
        tableCenters.some(
          (other) => Math.hypot(other[0] - point[0], other[1] - point[1]) < 1.7,
        )
      )
        continue;
      tableCenters.push(point);
      const top = new THREE.CylinderGeometry(
        tableRadius,
        tableRadius,
        0.1,
        12,
      ).toNonIndexed();
      top.translate(point[0], 0.88, point[1]);
      tableTops.push(top);
      const leg = new THREE.CylinderGeometry(0.1, 0.15, 0.7, 8).toNonIndexed();
      leg.translate(point[0], 0.48, point[1]);
      supports.push(leg);
    }
    group.userData.buffets.push({
      polygonId: buffet.polygonId,
      rotationDegrees: buffet.furnitureRotation,
      counter: { a: counterA, b: counterB, depth: 0.9 },
      tableCenters,
      tableRadius,
    });
  }
  // The user requests empty passages across the full shared boundary: no
  // frames, leaves, lintels or threshold meshes are drawn for this door bank.
  group.userData.openPassage = display.doorGroup || null;
  const definitions = [
    [tableTops, 0xb6a084, "Буфеты · условные столы"],
    [counterTops, 0x9c8770, "Буфеты · условные стойки"],
    [supports, 0x737c80, "Буфеты · основания"],
  ];
  for (const [geometries, color, name] of definitions) {
    if (!geometries.length) continue;
    for (const geometry of geometries)
      for (const key of Object.keys(geometry.attributes))
        if (!["position", "normal"].includes(key))
          geometry.deleteAttribute(key);
    const geometry = mergeGeometries(geometries);
    geometries.forEach((item) => item.dispose());
    const mesh = new THREE.Mesh(geometry, wallMaterial(color));
    mesh.name = name;
    mesh.userData = { ...group.userData };
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
