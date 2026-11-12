import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { getEntranceLayout } from "./entrance-layout.js";

/** Low-cost untextured landmarks. These never become collision or route data. */
export function createEntranceDetails(floor, { plan = false } = {}) {
  const group = new THREE.Group();
  group.name = "Главный вход · двери, рамки и пост охраны";
  const layout = getEntranceLayout(floor);
  if (!layout) return group;
  group.userData = { ...layout, plan };
  const geometry = [[], []];
  const parts = [];
  const add = (
    kind,
    center,
    along,
    length,
    depth,
    height,
    bottom = 0.14,
    tone = 0,
    omitPlan = false,
  ) => {
    parts.push({
      kind,
      center: [...center],
      along: [...along],
      length,
      depth,
      height,
      bottom,
      tone,
      omitPlan,
    });
    if (plan && omitPlan) return;
    const g = plan
      ? new THREE.PlaneGeometry(length, depth)
          .rotateX(-Math.PI / 2)
          .toNonIndexed()
      : new THREE.BoxGeometry(length, height, depth).toNonIndexed();
    g.rotateY(-Math.atan2(along[1], along[0]));
    g.translate(
      center[0],
      plan ? 0.185 + tone * 0.003 : bottom + height / 2,
      center[1],
    );
    g.deleteAttribute("uv");
    geometry[tone].push(g);
  };
  const { along, inside, width } = layout;
  const at = (across, depth) =>
    layout.front.a.map(
      (value, i) => value + along[i] * across + inside[i] * depth,
    );
  const doorPitch = width / layout.doors.count;
  for (let i = 0; i < layout.doors.count; i++) {
    const left = (i + 0.05) * doorPitch,
      right = (i + 0.95) * doorPitch;
    for (const position of [left, right]) {
      add("door-post", at(position, 0.1), along, 0.08, 0.12, 2.12);
      // Open leaves run along the entry direction, rather than filling the
      // formerly solid transverse wall. Opening angles are schematic.
      add(
        "open-double-door-leaf",
        at(position, 0.64),
        inside,
        1.08,
        0.055,
        1.98,
        0.18,
        1,
      );
    }
    add(
      "door-lintel",
      at((left + right) / 2, 0.1),
      along,
      right - left + 0.08,
      0.12,
      0.09,
      2.17,
      0,
      true,
    );
  }
  const holeHalf = layout.detectors.opening / 2;
  const innerAlong = layout.innerAlong;
  const afterFrame = (across, depth = 0) =>
    layout.inner.a.map(
      (value, i) =>
        value + innerAlong[i] * across + layout.innerInside[i] * depth,
    );
  const centers = layout.detectors.centers.map(
    (center) =>
      (center[0] - layout.inner.a[0]) * innerAlong[0] +
      (center[1] - layout.inner.a[1]) * innerAlong[1],
  );
  let start = 0.12;
  for (const c of centers) {
    const end = c - holeHalf - 0.06;
    if (end > start)
      add(
        "detector-side-partition",
        afterFrame((start + end) / 2),
        innerAlong,
        end - start,
        0.14,
        1.05,
      );
    for (const u of [c - holeHalf, c + holeHalf])
      add(
        "detector-upright",
        afterFrame(u),
        innerAlong,
        0.1,
        0.18,
        2.05,
        0.14,
        1,
      );
    add(
      "detector-lintel",
      afterFrame(c),
      innerAlong,
      layout.detectors.opening + 0.1,
      0.18,
      0.1,
      2.14,
      1,
      true,
    );
    start = c + holeHalf + 0.06;
  }
  if (start < layout.innerWidth - 0.12)
    add(
      "detector-side-partition",
      afterFrame((start + layout.innerWidth - 0.12) / 2),
      innerAlong,
      layout.innerWidth - 0.12 - start,
      0.14,
      1.05,
    );
  for (const center of layout.turnstiles.centers) {
    for (const offset of [-0.56, 0.56]) {
      const point = center.map((value, i) => value + innerAlong[i] * offset);
      add("turnstile-post", point, innerAlong, 0.22, 0.42, 0.86, 0.14, 1);
    }
    add("turnstile-arm", center, innerAlong, 0.92, 0.055, 0.055, 0.84, 1);
  }
  const guard = layout.guard;
  add(
    "security-desk",
    guard.deskCenter,
    guard.deskAlong,
    guard.deskLength,
    guard.deskDepth,
    0.76,
    0.14,
    1,
  );
  for (const center of guard.chairCenters) {
    add("security-chair-seat", center, innerAlong, 0.42, 0.42, 0.42, 0.14, 1);
    add(
      "security-chair-back",
      center.map((value, i) => value - innerAlong[i] * 0.17),
      layout.innerInside,
      0.42,
      0.08,
      0.36,
      0.55,
      1,
      plan,
    );
  }
  group.userData.parts = parts;
  for (const [i, geometries] of geometry.entries()) {
    if (!geometries.length) continue;
    const merged = mergeGeometries(geometries);
    geometries.forEach((g) => g.dispose());
    const material = plan
      ? new THREE.MeshBasicMaterial({
          color: i === 0 ? 0x9ba7b2 : 0x637d98,
          side: THREE.DoubleSide,
        })
      : new THREE.MeshStandardMaterial({
          color: i === 0 ? 0xb6c0ca : 0x7c94ac,
          roughness: 1,
        });
    const mesh = new THREE.Mesh(merged, material);
    mesh.name =
      i === 0
        ? "Проёмы и простые перегородки"
        : "Двери, рамки, турникеты и стол";
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }
  return group;
}
