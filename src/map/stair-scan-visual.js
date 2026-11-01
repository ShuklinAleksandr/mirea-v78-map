import * as THREE from "three";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import polygonClipping from "polygon-clipping";
import { convexHull } from "../data/spatial.js";
import { getFloorMarkers } from "../data/utils.js";
import dBindings from "../data/stair-scan-bindings.json" with { type: "json" };
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
  const result = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    const aIn = keepLower
      ? a[axis] <= boundary + epsilon
      : a[axis] >= boundary - epsilon;
    const bIn = keepLower
      ? b[axis] <= boundary + epsilon
      : b[axis] >= boundary - epsilon;
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

function clippedTriangles(layout, context, part) {
  const result = [];
  const indices = context.source.indices;
  for (let i = 0; i < indices.length; i += 3) {
    let triangle = indices
      .slice(i, i + 3)
      .map((index) => context.vertices[index]);
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
    for (let j = 1; j < triangle.length - 1; j++)
      result.push(
        [triangle[0], triangle[j], triangle[j + 1]].map((p) => [
          p[0],
          p[1] + part.offset + context.baseElevation,
          p[2],
        ]),
      );
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
  const positions = [];
  for (const part of parts)
    for (const triangle of clippedTriangles(layout, context, part))
      for (const p of triangle) positions.push(...toWorld(layout, p, anchor));
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
    riser = new THREE.Color(0x9eacb6),
    tone = new THREE.Color();
  for (let i = 0; i < normals.count; i++) {
    // Display tones derive only from the final smoothed surface orientation;
    // source RGB is never read. Linear-space interpolation avoids hard bands.
    const up = THREE.MathUtils.smoothstep(normals.getY(i), 0.5, 0.9);
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
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `${layout.label} · observed scan surface`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
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
    synthesizedSurfaces: false,
    normalSmoothing: { creaseDegrees: 20, positionsChanged: false },
    displayColor: {
      method: "procedural-smoothed-up-normal-smoothstep",
      stone: "#d7e0e5",
      riser: "#9eacb6",
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
  if (dLayoutCache.has(floor)) return dLayoutCache.get(floor);
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
    landings: [],
    routingStatus: "existing-source-transitions-only-no-added-edges",
    note: "Настоящая поверхность пользовательского скана; тип подтверждён пользователем, привязка к исходной ячейке и высота приблизительны. Новых связей графа нет.",
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
    };
  }
  const layouts = [layout];
  dLayoutCache.set(floor, layouts);
  return layouts;
}
