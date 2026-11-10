import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { createRouteGuidance } from "./route-guidance.js";
import { roundWalkingRoute } from "./route-rounding.js";

const isPoint = (p) =>
  Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(Number.isFinite);

// Keep each source segment separate: merging by floor would draw a false
// shortcut when a route visits the same floor more than once.
export function visibleRouteSegments(route, floorId) {
  return (route?.segments || [])
    .map((segment, sourceSegmentIndex) => ({ ...segment, sourceSegmentIndex }))
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

const routeLineDistances = new WeakMap();

function lineDistances(points) {
  let distances = routeLineDistances.get(points);
  if (distances) return distances;
  distances = [0];
  for (let i = 1; i < points.length; i++)
    distances.push(
      distances[i - 1] +
        Math.hypot(
          points[i][0] - points[i - 1][0],
          points[i][1] - points[i - 1][1],
        ),
    );
  routeLineDistances.set(points, distances);
  return distances;
}

export function nearestRouteLinePosition(points, point, expectedDistance) {
  const distances = lineDistances(points);
  let best = null;
  // Rounded corners may shift the visible line by at most 0.75 map units.
  let bestScore = Infinity;
  for (let i = 1; i < points.length; i++) {
    const [x, z] = points[i - 1];
    const [nextX, nextZ] = points[i];
    const dx = nextX - x;
    const dz = nextZ - z;
    const squaredLength = dx * dx + dz * dz;
    if (!squaredLength) continue;
    const t = Math.max(
      0,
      Math.min(1, ((point[0] - x) * dx + (point[1] - z) * dz) / squaredLength),
    );
    const candidate = [x + t * dx, z + t * dz];
    const squaredError =
      (candidate[0] - point[0]) ** 2 + (candidate[1] - point[1]) ** 2;
    if (squaredError >= 0.75 ** 2) continue;
    const distance = THREE.MathUtils.lerp(distances[i - 1], distances[i], t);
    // Prefer the right visit where a route crosses its own geometry.
    const score =
      squaredError +
      (Number.isFinite(expectedDistance)
        ? Math.min(20, Math.abs(distance - expectedDistance)) * 0.01
        : 0);
    if (score < bestScore) {
      best = { point: candidate, distance };
      bestScore = score;
    }
  }
  return best;
}

export function routeLinePointAtDistance(points, distance) {
  const distances = lineDistances(points);
  let left = 0,
    right = points.length - 1;
  while (right - left > 1) {
    const middle = Math.floor((left + right) / 2);
    if (distances[middle] < distance) left = middle;
    else right = middle;
  }
  const length = distances[right] - distances[left];
  const t = length
    ? THREE.MathUtils.clamp((distance - distances[left]) / length, 0, 1)
    : 0;
  return [
    THREE.MathUtils.lerp(points[left][0], points[right][0], t),
    THREE.MathUtils.lerp(points[left][1], points[right][1], t),
  ];
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
          distance: next,
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
  const traveled = dark ? 0x9a9da4 : 0x74787f;
  const nextColor = dark ? 0xffca72 : 0xb0600e;
  const legs = new Map(),
    checkpoints = [];
  // In the stacked cutaway, transparent slabs are drawn after opaque objects.
  // Put the entire route in their queue with a later render order so the path
  // remains legible through upper floors without moving its real geometry.
  const visibility = {
    transparent: overlay,
    depthTest: !overlay,
    depthWrite: false,
  };

  function lineGeometry(points, elevation) {
    return new LineGeometry().setPositions(
      points.flatMap(([x, z]) => [x, elevation, z]),
    );
  }
  function line(points, color, linewidth, elevation, order) {
    const geometry = lineGeometry(points, elevation);
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
    return object;
  }
  for (const segment of paths) {
    if (segment.points.length < 2) continue;
    line(segment.points, dark ? 0x182a49 : 0xffffff, 12, 0.29, 8);
    const stroke = line(segment.points, blue, 7, 0.31, 9);
    const leg = {
      points: segment.points,
      distances: lineDistances(segment.points),
      stroke,
      arrows: [],
      traveledDistance: 0,
    };
    legs.set(segment.sourceSegmentIndex, leg);
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
      leg.arrows.push({ arrow, distance: anchor.distance });
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
  function marker(point, type, label, checkpoint) {
    if (!isPoint(point)) return;
    const object = new THREE.Group();
    object.position.set(point[0], 0.38, point[1]);
    const turn = type === "turn";
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(turn ? 0.3 : 0.65, turn ? 0.5 : 1, 24),
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
      new THREE.CircleGeometry(turn ? 0.33 : 0.7, 24),
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
    if (label) labels.push({ point, text: label, type });
    if (checkpoint) {
      checkpoints.push({ ...checkpoint, object, ring, dot });
      object.userData.routeCheckpoint = checkpoint.stepIndex;
    }
  }
  const guide = createRouteGuidance(route);
  const transitionCheckpoints = new Map();
  let endCheckpoint;
  for (const anchor of guide.anchors) {
    const step = route.steps[anchor.stepIndex];
    if (step.kind !== "turn" && step.kind !== "arrive" && !step.targetFloorId)
      continue;
    const section = guide.sections[anchor.sectionIndex];
    if (section.floorId !== floorId) continue;
    const leg = legs.get(section.sourceSegmentIndex);
    if (!leg) continue;
    const estimatedDistance =
      (anchor.distance / section.length) * leg.distances.at(-1);
    const projection = nearestRouteLinePosition(
      leg.points,
      step.position,
      estimatedDistance,
    );
    if (!projection) continue;
    const checkpoint = {
      sourceSegmentIndex: section.sourceSegmentIndex,
      stepIndex: anchor.stepIndex,
      distance: projection.distance,
    };
    if (step.kind === "turn") {
      if (!overlay) marker(projection.point, "turn", null, checkpoint);
    } else if (step.kind === "arrive") endCheckpoint = checkpoint;
    else if (section.transition)
      transitionCheckpoints.set(section.transition, checkpoint);
  }
  if (route?.start?.floorId === floorId)
    marker(route.start.point, "start", "Старт");
  if (route?.end?.floorId === floorId)
    marker(
      route.end.point,
      "end",
      route.end.label || "Назначение",
      endCheckpoint,
    );
  for (const transition of route?.transitions || []) {
    if (transition.fromFloorId === floorId)
      marker(
        transition.point,
        "transition",
        transition.label || "Переход на другой этаж",
        transitionCheckpoints.get(transition),
      );
    if (transition.toFloorId === floorId)
      marker(transition.targetPoint, "arrival", "Продолжение маршрута");
  }
  checkpoints.sort((a, b) => a.stepIndex - b.stepIndex);

  function paintLeg(leg, distance) {
    if (leg.traveledDistance === distance) return false;
    leg.traveledDistance = distance;
    const length = leg.distances.at(-1);
    const full = distance >= length;
    leg.stroke.material.color.setHex(full ? traveled : blue);
    if (distance > 0 && !full) {
      const end = leg.distances.findIndex((item) => item >= distance);
      const prefix = [
        ...leg.points.slice(0, end),
        routeLinePointAtDistance(leg.points, distance),
      ];
      if (!leg.traveledStroke) {
        leg.traveledStroke = line(prefix, traveled, 7, 0.32, 10);
        leg.traveledStroke.name = "Traveled route";
      } else {
        leg.traveledStroke.geometry.dispose();
        leg.traveledStroke.geometry = lineGeometry(prefix, 0.32);
      }
    }
    if (leg.traveledStroke) leg.traveledStroke.visible = distance > 0 && !full;
    for (const { arrow, distance: at } of leg.arrows)
      arrow.userData.routePassed = at <= distance;
    return true;
  }

  function setProgress(sample) {
    const sourceIndex = sample?.sourceSegmentIndex;
    const currentLeg = legs.get(sourceIndex);
    const projection =
      currentLeg && isPoint(sample?.position)
        ? nearestRouteLinePosition(
            currentLeg.points,
            sample.position,
            (sample.distance / sample.length) * currentLeg.distances.at(-1),
          )
        : null;
    const currentDistance =
      projection?.distance ?? currentLeg?.traveledDistance ?? 0;
    let changed = false;
    for (const [index, leg] of legs) {
      const distance =
        index < sourceIndex
          ? leg.distances.at(-1)
          : index === sourceIndex
            ? currentDistance
            : 0;
      changed = paintLeg(leg, distance) || changed;
    }
    const next =
      checkpoints.find(
        (point) =>
          point.sourceSegmentIndex === sourceIndex &&
          point.stepIndex === sample?.nextStepIndex,
      ) ||
      checkpoints.find(
        (point) =>
          point.sourceSegmentIndex === sourceIndex &&
          point.distance > currentDistance + 0.1,
      );
    for (const checkpoint of checkpoints) {
      const { object, ring, dot } = checkpoint;
      const status =
        checkpoint === next
          ? "next"
          : checkpoint.sourceSegmentIndex < sourceIndex ||
              (checkpoint.sourceSegmentIndex === sourceIndex &&
                checkpoint.distance <= currentDistance)
            ? "passed"
            : "remaining";
      if (object.userData.routeProgress === status) continue;
      object.userData.routeProgress = status;
      dot.material.color.setHex(
        status === "next" ? nextColor : status === "passed" ? traveled : blue,
      );
      ring.scale.setScalar(status === "next" ? 1.2 : 1);
      changed = true;
    }
    return changed;
  }
  return { group, materials, markers, arrows, labels, paths, setProgress };
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
