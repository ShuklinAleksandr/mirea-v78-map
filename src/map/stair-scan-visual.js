import * as THREE from "three";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import polygonClipping from "polygon-clipping";
import { convexHull } from "../data/spatial.js";
import { stairScanDisplayTopology } from "./stair-scan-repair.js";
import { stairScanBinding } from "./stair-model-bindings.js";
export {
  stairScanBinding,
  stairScanReference,
  scanBackedStairLayoutsForFloor,
} from "./stair-model-bindings.js";
import grandUpper from "../data/stair-scan-meshes/grand-upper.json" with { type: "json" };
import standardCell from "../data/stair-scan-meshes/standard-cell.json" with { type: "json" };
import grandLower from "../data/stair-scan-meshes/grand-lower.json" with { type: "json" };

const sources = {
  "grand-upper": grandUpper,
  "standard-cell": standardCell,
  "grand-lower": grandLower,
};
const checked = new WeakMap();
const openingCache = new WeakMap();
const epsilon = 1e-7;
const point = (p) =>
  Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

function inspectSource(source) {
  if (checked.has(source)) return checked.get(source);
  const { positions, indices, horizontalAxes, floorRange } = source;
  if (
    !Array.isArray(positions) ||
    positions.length < 9 ||
    positions.length % 3 ||
    !positions.every(Number.isFinite) ||
    !Array.isArray(indices) ||
    indices.length < 3 ||
    indices.length % 3 ||
    indices.length > 72_000 ||
    !indices.every(
      (n) => Number.isInteger(n) && n >= 0 && n < positions.length / 3,
    ) ||
    source.upAxis !== "Z" ||
    !point(horizontalAxes?.u) ||
    !point(horizontalAxes?.v) ||
    !point(floorRange) ||
    floorRange[1] <= floorRange[0]
  )
    throw new Error(`Invalid observed stair scan: ${source.id}`);
  const { u, v } = horizontalAxes;
  const determinant = u[0] * v[1] - u[1] * v[0];
  if (
    Math.abs(Math.hypot(...u) - 1) > 1e-5 ||
    Math.abs(Math.hypot(...v) - 1) > 1e-5 ||
    Math.abs(u[0] * v[0] + u[1] * v[1]) > 1e-5 ||
    Math.abs(determinant + 1) > 1e-5
  )
    throw new Error(
      `Stair scan must retain right-handed Z-up orientation: ${source.id}`,
    );
  const vertices = [];
  const min = [Infinity, Infinity],
    max = [-Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    const p = [
      u[0] * positions[i] + u[1] * positions[i + 1],
      positions[i + 2],
      v[0] * positions[i] + v[1] * positions[i + 1],
    ];
    vertices.push(p);
    for (let j = 0; j < 2; j++) {
      min[j] = Math.min(min[j], p[j * 2]);
      max[j] = Math.max(max[j], p[j * 2]);
    }
  }
  const fit = source.fitBounds;
  if (fit) {
    if (
      !point(fit.min) ||
      !point(fit.max) ||
      fit.max.some((n, i) => n <= fit.min[i])
    )
      throw new Error(`Invalid stair registration crop: ${source.id}`);
    for (let i = 0; i < 2; i++) {
      min[i] = Math.max(min[i], fit.min[i]);
      max[i] = Math.min(max[i], fit.max[i]);
    }
  }
  const result = { vertices, min, max };
  checked.set(source, result);
  return result;
}

function validFrame(frame) {
  if (
    !frame ||
    !point(frame.origin) ||
    !point(frame.axisU) ||
    !point(frame.axisV) ||
    !point(frame.size) ||
    frame.size.some((n) => n <= 0)
  )
    return false;
  const det = frame.axisU[0] * frame.axisV[1] - frame.axisU[1] * frame.axisV[0];
  return (
    Math.abs(det - 1) < 1e-4 &&
    Math.abs(Math.hypot(...frame.axisU) - 1) < 1e-4 &&
    Math.abs(Math.hypot(...frame.axisV) - 1) < 1e-4
  );
}

function projection(
  layout,
  binding,
  { floorRise = 3.6, baseElevation = 0.14 } = {},
) {
  const source = sources[binding.assetId];
  if (
    !source ||
    !validFrame(layout.frame) ||
    !Number.isFinite(floorRise) ||
    floorRise <= 0 ||
    !Number.isFinite(baseElevation)
  )
    throw new Error("Invalid stair scan placement");
  const data = inspectSource(source);
  const sourceSize = data.max.map((n, i) => n - data.min[i]);
  const horizontalScale = Math.min(
    ...layout.frame.size.map((n, i) => (n * 0.98) / sourceSize[i]),
  );
  const sourceCenter = data.min.map((n, i) => (n + data.max[i]) / 2);
  const verticalScale =
    floorRise / (binding.floorRange[1] - binding.floorRange[0]);
  const vertices = data.vertices.map(([u, z, v]) => [
    (u - sourceCenter[0]) * horizontalScale + layout.frame.size[0] / 2,
    (z - binding.floorRange[0]) * verticalScale,
    (v - sourceCenter[1]) * horizontalScale + layout.frame.size[1] / 2,
  ]);
  const displayBounds = {
    min: sourceSize.map(
      (n, i) => layout.frame.size[i] / 2 - (n * horizontalScale) / 2,
    ),
    max: sourceSize.map(
      (n, i) => layout.frame.size[i] / 2 + (n * horizontalScale) / 2,
    ),
  };
  return {
    source,
    vertices,
    horizontalScale,
    verticalScale,
    floorRise,
    baseElevation,
    displayBounds,
  };
}

// Clip actual observed triangles; no cap, missing surface, tread or wall is made.
function clip(polygon, axis, boundary, keepLower) {
  if (!polygon.length) return [];
  const limit = boundary + (keepLower ? epsilon : -epsilon);
  const contains = (p) => (keepLower ? p[axis] <= limit : p[axis] >= limit);
  if (polygon.every(contains)) return polygon;
  if (!polygon.some(contains)) return [];
  const result = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    const aIn = contains(a);
    const bIn = contains(b);
    if (aIn) result.push(a);
    if (aIn !== bIn) {
      const t = (boundary - a[axis]) / (b[axis] - a[axis]);
      result.push(a.map((n, j) => n + (b[j] - n) * t));
    }
  }
  return result;
}

function partsFor(layout, binding, context, stack) {
  const { floorRise } = context;
  const bottom = -0.15;
  // The multi-storey lower scan is sliced at observed level planes. Retaining
  // the next storey's steps as "railing" would duplicate the real geometry.
  const top = binding.assetId === "grand-lower" ? floorRise : floorRise + 0.9;
  if (layout.incomingDisplay && !stack && binding.assetId === "standard-cell")
    return [
      {
        name: "outgoing-half",
        offset: 0,
        minY: bottom,
        maxY: floorRise / 2 + 0.9,
        side: "left",
      },
      {
        name: "incoming-half",
        offset: -floorRise,
        minY: floorRise / 2 - 0.15,
        maxY: top,
        side: "right",
      },
    ];
  if (layout.incomingDisplayOnly && binding.assetId === "standard-cell")
    return [
      {
        name: "incoming-half",
        offset: -floorRise,
        minY: floorRise / 2 - 0.15,
        maxY: top,
        side: "right",
      },
    ];
  return [
    {
      name:
        layout.levelRole === "upper-arrival"
          ? "upper-arrival"
          : "lower-departure",
      offset: layout.levelRole === "upper-arrival" ? -floorRise : 0,
      minY: bottom,
      maxY: top,
    },
  ];
}

function clippedTriangles(
  layout,
  context,
  part,
  indices = context.source.indices,
) {
  const result = [];
  const origin = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  for (let i = 0; i < indices.length; i += 3) {
    let triangle = [
      context.vertices[indices[i]],
      context.vertices[indices[i + 1]],
      context.vertices[indices[i + 2]],
    ];
    triangle = clip(clip(triangle, 1, part.minY, false), 1, part.maxY, true);
    for (const [j, axis] of [0, 2].entries()) {
      triangle = clip(
        clip(triangle, axis, context.displayBounds.min[j], false),
        axis,
        context.displayBounds.max[j],
        true,
      );
    }
    if (part.side)
      triangle = clip(
        triangle,
        0,
        layout.frame.size[0] / 2,
        part.side === "left",
      );
    for (let j = 1; j < triangle.length - 1; j++) {
      origin.fromArray(triangle[0]);
      ab.fromArray(triangle[j]).sub(origin);
      ac.fromArray(triangle[j + 1]).sub(origin);
      if (ab.cross(ac).lengthSq() <= 1e-12) continue;
      result.push(
        [triangle[0], triangle[j], triangle[j + 1]].map((p) => [
          p[0],
          p[1] + part.offset + context.baseElevation,
          p[2],
        ]),
      );
    }
  }
  return result;
}

function toWorld(layout, [u, y, v], anchor = [0, 0]) {
  const frame = layout.frame;
  return [
    frame.origin[0] + frame.axisU[0] * u + frame.axisV[0] * v - anchor[0],
    y,
    frame.origin[1] + frame.axisU[1] * u + frame.axisV[1] * v - anchor[1],
  ];
}

export function createStairScanVisual(layout, marker, options = {}) {
  const binding = stairScanBinding(layout);
  if (!binding) return null;
  const anchor = marker?.position || marker?.center;
  if (!point(anchor)) throw new Error("Stair scan marker has no source anchor");
  const context = projection(layout, binding, options);
  const parts = partsFor(layout, binding, context, options.stack);
  const repairs = stairScanDisplayTopology(context.source);
  const positions = [];
  let repairedTriangles = 0;
  for (const part of parts) {
    for (const triangle of clippedTriangles(
      layout,
      context,
      part,
      repairs.observedIndices,
    ))
      for (const p of triangle) positions.push(...toWorld(layout, p, anchor));
    const patches = clippedTriangles(
      layout,
      context,
      part,
      repairs.patchIndices,
    );
    repairedTriangles += patches.length;
    for (const triangle of patches)
      for (const p of triangle) positions.push(...toWorld(layout, p, anchor));
  }
  if (!positions.length)
    throw new Error(`No observed scan geometry for ${layout.id}`);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  // Non-indexed input is updated in place; no second disposable geometry is
  // created. A small crease threshold retains the real tread/riser boundaries.
  toCreasedNormals(geometry, Math.PI / 9);
  const normals = geometry.getAttribute("normal");
  const colors = new Float32Array(normals.count * 3);
  const stone = new THREE.Color(0xd7e0e5),
    riser = new THREE.Color(0xb9c7d1),
    tone = new THREE.Color();
  for (let i = 0; i < normals.count; i++) {
    // Display tones derive only from the final smoothed surface orientation;
    // source RGB is never read. Linear-space interpolation avoids hard bands.
    const up = THREE.MathUtils.smoothstep(Math.abs(normals.getY(i)), 0.5, 0.9);
    tone
      .copy(riser)
      .lerp(stone, up)
      .toArray(colors, i * 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingBox();
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `${layout.label} · observed scan surface`;
  mesh.castShadow = true;
  // The open sheets from point clouds can shadow themselves at near-contact
  // points, creating dark chunks across otherwise intact treads.
  mesh.receiveShadow = false;
  mesh.userData = {
    room: marker,
    layoutId: layout.id,
    scanAssetId: binding.assetId,
  };
  const group = new THREE.Group();
  group.position.set(anchor[0], 0, anchor[1]);
  group.add(mesh);
  group.userData.scanVisual = {
    assetId: binding.assetId,
    source: context.source.source,
    sourceSha256: context.source.sourceSha256,
    reconstruction: context.source.reconstruction,
    crop: context.source.crop,
    displayRegistrationCrop: context.source.fitBounds || null,
    sourceFloorRange: [...binding.floorRange],
    horizontalScale: context.horizontalScale,
    horizontalScaleStatus: "uniform-fit-to-existing-approximate-plan-frame",
    verticalScale: context.verticalScale,
    verticalScaleStatus: "explicit-fit-to-assumed-floor-rise-not-surveyed",
    floorRise: context.floorRise,
    handedness: "right-handed-raw-Z-up-to-scene-Y-up",
    evidence: binding.evidence,
    parts: parts.map((part) => part.name),
    rawTriangles: context.source.indices.length / 3,
    displayedTriangles: positions.length / 9,
    textures: false,
    synthesizedSurfaces: repairedTriangles > 0,
    displayRepairs: {
      method: "small-closed-boundary-tread-interpolation",
      sourceHoles: repairs.holes,
      displayedTriangles: repairedTriangles,
      isolatedSourceTrianglesHidden: repairs.isolatedTriangles,
    },
    normalSmoothing: { creaseDegrees: 20, positionsChanged: false },
    displayColor: {
      method: "procedural-smoothed-absolute-normal-smoothstep",
      stone: "#d7e0e5",
      riser: "#b9c7d1",
      normalYRange: [0.5, 0.9],
      sourceColors: false,
    },
  };
  return group;
}

/** Display openings follow the observed descending walking surfaces. Bounds
 * remain the existing frame and actual source cell/hall, never a new floor plan. */
export function getStairScanDisplayCutouts(layout, { floor } = {}) {
  if (!layout?.displayCutout) return [];
  const binding = stairScanBinding(layout);
  if (!binding) return [];
  const area =
    floor?.polygons?.find((p) => p.id === layout.fitAreaId) ||
    floor?.polygons?.find((p) => p.id === layout.containerAreaId);
  const cellPoints = layout.sourceCellPoints || area?.points;
  const key = JSON.stringify(cellPoints || null);
  const previous = openingCache.get(layout);
  if (previous?.key === key) return previous.openings;
  const context = projection(layout, binding);
  const parts = partsFor(layout, binding, context, false);
  const branches = [[], []];
  for (const part of parts)
    for (const triangle of clippedTriangles(layout, context, part)) {
      const a = new THREE.Vector3(...triangle[0]),
        b = new THREE.Vector3(...triangle[1]),
        c = new THREE.Vector3(...triangle[2]);
      const normal = b.sub(a).cross(c.sub(a));
      // Down-facing ceilings and wall/rail faces do not define walking openings.
      if (!normal.lengthSq() || normal.y / normal.length() < 0.35) continue;
      const below = clip(
        clip(
          triangle,
          1,
          context.baseElevation - context.floorRise + 0.08,
          false,
        ),
        1,
        context.baseElevation - 0.05,
        true,
      );
      if (below.length < 3) continue;
      for (const side of [0, 1])
        branches[side].push(
          ...clip(below, 0, layout.frame.size[0] / 2, side === 0).map((p) => {
            const w = toWorld(layout, p);
            return [w[0], w[2]];
          }),
        );
    }
  const hulls = branches.map(convexHull).filter((ring) => ring.length >= 3);
  const framePoints = [
    [0, 0],
    [layout.frame.size[0], 0],
    layout.frame.size,
    [0, layout.frame.size[1]],
  ].map(([u, v]) => {
    const p = toWorld(layout, [u, 0, v]);
    return [p[0], p[2]];
  });
  const openings = (
    hulls.length
      ? polygonClipping.intersection(
          polygonClipping.union(...hulls.map((ring) => [ring])),
          [framePoints],
          ...(cellPoints ? [[cellPoints, ...(area?.holes || [])]] : []),
        )
      : []
  )
    .map((polygon) => polygon[0].slice(0, -1))
    .filter((ring) => ring.length >= 3)
    .map((points, openingIndex) => ({
      layoutId: layout.id,
      sourcePolygonIds: layout.sourcePolygonIds,
      openingIndex,
      points,
      geometryEvidence:
        "observed-descending-scan-surface-projection-bounded-by-source-cell",
      sourceSha256: context.source.sourceSha256,
    }));
  openingCache.set(layout, { key, openings });
  return openings;
}
