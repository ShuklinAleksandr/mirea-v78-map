import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { roundWalkingRoute } from "./route-rounding.js";

const isPoint = (p) =>
  Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(Number.isFinite);

// Keep each source segment separate: merging by floor would draw a false
// shortcut when a route visits the same floor more than once.
export function visibleRouteSegments(route, floorId) {
  return (route?.segments || [])
    .filter(
      (segment) =>
        segment.floorId === floorId &&
        Array.isArray(segment.points) &&
        segment.points.every(isPoint),
    )
    .map((segment) => {
      const keep = segment.points.map(
        (p, i, points) =>
          !i ||
          Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-6,
      );
      return {
        ...segment,
        points: segment.points.filter((_, i) => keep[i]),
        ...(segment.nodes?.length === segment.points.length
          ? { nodes: segment.nodes.filter((_, i) => keep[i]) }
          : {}),
      };
    })
    .filter((segment) => segment.points.length > 0);
}

export function routeBounds(route, floorId, margin = 3) {
  const points = visibleRouteSegments(route, floorId).flatMap((s) => s.points);
  if (!points.length) return null;
  return [
    Math.min(...points.map((p) => p[0])) - margin,
    Math.min(...points.map((p) => p[1])) - margin,
    Math.max(...points.map((p) => p[0])) + margin,
    Math.max(...points.map((p) => p[1])) + margin,
  ];
}

export function routeArrowAnchors(points, spacing = 6) {
  const result = [];
  let next = spacing / 2;
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const dx = b[0] - a[0],
      dz = b[1] - a[1];
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    while (next < travelled + length) {
      const t = (next - travelled) / length;
      // Avoid placing a directional chevron exactly on a turn.
      if (t > 0.1 && t < 0.9) {
        result.push({
          point: [a[0] + t * dx, a[1] + t * dz],
          angle: -Math.atan2(dz, dx),
        });
      }
      next += spacing;
    }
    travelled += length;
  }
  return result;
}

export function createRouteLayer(
  route,
  floorId,
  {
    dark = false,
    stairPaths = [],
    overlay = false,
    floor = null,
    protectedAreaIds = [],
    protectedRegions = [],
  } = {},
) {
  const group = new THREE.Group();
  group.name = "Verified route · active level";
  const materials = [],
    markers = [],
    arrows = [],
    labels = [];
  const segments = visibleRouteSegments(route, floorId);
  const paths = segments.map((segment) =>
    roundWalkingRoute(
      segment,
      route,
      floor,
      protectedAreaIds,
      protectedRegions,
    ),
  );
  group.userData.roundedRouteCorners = paths.reduce(
    (total, segment) => total + segment.roundedCorners,
    0,
  );
  const blue = dark ? 0x75a8ff : 0x246bfd;
  // In the stacked cutaway, transparent slabs are drawn after opaque objects.
  // Put the entire route in their queue with a later render order so the path
  // remains legible through upper floors without moving its real geometry.
  const visibility = {
    transparent: overlay,
    depthTest: !overlay,
    depthWrite: false,
  };

  function line(points, color, linewidth, elevation, order) {
    const geometry = new LineGeometry();
    geometry.setPositions(points.flatMap(([x, z]) => [x, elevation, z]));
    const material = new LineMaterial({
      color,
      linewidth,
      worldUnits: false,
      alphaToCoverage: true,
      ...visibility,
      toneMapped: false,
    });
    const object = new Line2(geometry, material);
    object.computeLineDistances();
    object.renderOrder = order;
    object.frustumCulled = false;
    materials.push(material);
    group.add(object);
  }
  for (const segment of paths) {
    if (segment.points.length < 2) continue;
    line(segment.points, dark ? 0x182a49 : 0xffffff, 12, 0.29, 8);
    line(segment.points, blue, 7, 0.31, 9);
    for (const anchor of routeArrowAnchors(segment.points)) {
      const geometry = new THREE.BufferGeometry();
      // Chevron points along +X; all vertices stay in the floor plane.
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          [
            -0.6, 0, -0.65, 0.6, 0, 0, -0.6, 0, 0.65, -0.6, 0, -0.65, -0.1, 0,
            0, -0.6, 0, 0.65,
          ],
          3,
        ),
      );
      const arrow = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          side: THREE.DoubleSide,
          ...visibility,
          toneMapped: false,
        }),
      );
      arrow.position.set(anchor.point[0], 0.35, anchor.point[1]);
      arrow.rotation.y = anchor.angle;
      arrow.renderOrder = 10;
      arrows.push(arrow);
      group.add(arrow);
    }
  }
  for (const path of stairPaths) {
    for (const [color, linewidth, order] of [
      [dark ? 0x182a49 : 0xffffff, 11, 11],
      [blue, 6, 12],
    ]) {
      const geometry = new LineGeometry();
      geometry.setPositions(path.points.flat());
      const material = new LineMaterial({
        color,
        linewidth,
        worldUnits: false,
        alphaToCoverage: true,
        ...visibility,
        toneMapped: false,
      });
      const object = new Line2(geometry, material);
      object.computeLineDistances();
      object.renderOrder = order;
      object.userData.stairPath = path.status;
      object.userData.sourceEdgeId = path.sourceEdgeId;
      group.add(object);
      materials.push(material);
    }
    // Source graph anchors and photo meshes have independent approximate
    // placement. Show that small connection explicitly as schematic.
    const anchor = [path.sourcePoint[0], 0.32, path.sourcePoint[1]];
    const end = path.anchorAtEnd ? path.points.at(-1) : path.points[0];
    if (Math.hypot(anchor[0] - end[0], anchor[2] - end[2]) > 0.1) {
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...anchor),
        new THREE.Vector3(...end),
      ]);
      const dashed = new THREE.Line(
        geometry,
        new THREE.LineDashedMaterial({
          color: blue,
          dashSize: 0.3,
          gapSize: 0.2,
          toneMapped: false,
          ...visibility,
        }),
      );
      dashed.computeLineDistances();
      dashed.renderOrder = 12;
      dashed.userData.status = "source-to-photo-placement-approximate";
      group.add(dashed);
    }
  }
  function marker(point, type, label) {
    if (!isPoint(point)) return;
    const object = new THREE.Group();
    object.position.set(point[0], 0.38, point[1]);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.65, 1, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        toneMapped: false,
        ...visibility,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 13;
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.7, 40),
      new THREE.MeshBasicMaterial({
        color: type === "start" ? 0x172b4d : blue,
        side: THREE.DoubleSide,
        toneMapped: false,
        ...visibility,
      }),
    );
    dot.rotation.x = -Math.PI / 2;
    dot.renderOrder = 14;
    dot.position.y = 0.005;
    object.add(ring, dot);
    object.userData.routeMarker = type;
    group.add(object);
    markers.push(object);
    labels.push({ point, text: label, type });
  }
  if (route?.start?.floorId === floorId)
    marker(route.start.point, "start", "Старт");
  if (route?.end?.floorId === floorId)
    marker(route.end.point, "end", route.end.label || "Назначение");
  for (const transition of route?.transitions || []) {
    if (transition.fromFloorId === floorId)
      marker(
        transition.point,
        "transition",
        transition.label || "Переход на другой этаж",
      );
    if (transition.toFloorId === floorId)
      marker(transition.targetPoint, "arrival", "Продолжение маршрута");
  }
  return { group, materials, markers, arrows, labels, paths };
}

export function disposeRouteLayer(layer) {
  if (!layer) return;
  layer.group.traverse((object) => {
    object.geometry?.dispose();
    for (const material of [].concat(object.material || [])) material.dispose();
  });
  layer.group.removeFromParent();
  layer.group.clear();
}

export function createSchematicConnection(points, dark = false) {
  const group = new THREE.Group();
  const geometry = new LineGeometry();
  geometry.setPositions(points.flat());
  const material = new LineMaterial({
    color: dark ? 0x9dc0ff : 0x246bfd,
    linewidth: 3,
    worldUnits: false,
    dashed: true,
    dashSize: 0.65,
    gapSize: 0.4,
    transparent: true,
    opacity: 0.72,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const line = new Line2(geometry, material);
  line.computeLineDistances();
  line.renderOrder = 12;
  line.userData.status = "source-stair-placement-approximate";
  group.add(line);
  return { group, materials: [material], arrows: [], markers: [], labels: [] };
}
