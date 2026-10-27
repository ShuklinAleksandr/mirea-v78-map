import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { createExterior } from "../src/map/exterior.js";
import { createEntranceHall } from "../src/map/hall.js";

const read = (name) =>
  JSON.parse(
    readFileSync(new URL(`../public/data/${name}`, import.meta.url), "utf8"),
  );
const data = read("exterior-shells.json");
const style = read("facade-style.json");
const hall = read("exterior-hall.json");
const special = read("exterior-special.json");

function dispose(group) {
  const geometries = new Set(),
    materials = new Set();
  group.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of [].concat(object.material || []))
      materials.add(material);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}
function renderedShells(campus, entranceHall = null) {
  const replaced = new Set([
    ...(entranceHall?.replaceShellOverrideIds || []),
    ...(entranceHall
      ? special.features.flatMap((f) => f.replaceShellOverrideIds || [])
      : []),
  ]);
  return (campus.displayShells || campus.shells).filter(
    (p) =>
      !replaced.has(p.overrideRoomId || p.overrideSourceId || p.sourceRoomId),
  );
}
function ringArea(points) {
  return (
    Math.abs(
      points.reduce((sum, a, index) => {
        const b = points[(index + 1) % points.length];
        return sum + a[0] * b[1] - b[0] * a[1];
      }, 0),
    ) / 2
  );
}
const polygonArea = (p) =>
  ringArea(p.points) - (p.holes || []).reduce((sum, h) => sum + ringArea(h), 0);
function trianglesOf(mesh) {
  const geometry = mesh.geometry,
    positions = geometry.getAttribute("position"),
    index = geometry.index;
  const count = index?.count || positions.count,
    triangles = [];
  for (let i = 0; i < count; i += 3) {
    triangles.push(
      [0, 1, 2].map((offset) =>
        new THREE.Vector3().fromBufferAttribute(
          positions,
          index ? index.getX(i + offset) : i + offset,
        ),
      ),
    );
  }
  return triangles;
}
function projectedArea([a, b, c]) {
  return Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2;
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
const inPolygon = (point, p) =>
  pointInRing(point, p.points) &&
  !(p.holes || []).some((h) => pointInRing(point, h));

for (const [id, campus] of Object.entries(data.campuses)) {
  test(`${id}: rendered exterior has finite geometry and preserves semantic footprint and heights`, () => {
    const entranceHall = id === hall.campusId ? hall : null;
    const model = createExterior(campus, {
      photoDetail: id === "v-78",
      style,
      hall: entranceHall,
      special: id === special.campusId ? special : null,
    });
    try {
      model.group.updateMatrixWorld(true);
      model.group.traverse((object) => {
        if (!object.geometry) return;
        for (const [name, attribute] of Object.entries(
          object.geometry.attributes,
        )) {
          assert.ok(
            Array.from(attribute.array).every(Number.isFinite),
            `${id}: ${name} contains a non-finite value`,
          );
        }
        if (object.geometry.index)
          assert.ok(
            Array.from(object.geometry.index.array).every(
              (i) => i < object.geometry.attributes.position.count,
            ),
            "index points outside the position buffer",
          );
      });
      const expected = new THREE.Box3();
      for (const p of renderedShells(campus, entranceHall))
        for (const [x, z] of p.points) {
          expected.expandByPoint(new THREE.Vector3(x, p.base || 0, z));
          expected.expandByPoint(
            new THREE.Vector3(x, (p.base || 0) + p.height, z),
          );
        }
      const actual = new THREE.Box3();
      model.pickables
        .filter((mesh) => !mesh.userData.exteriorFeature)
        .forEach((mesh) => actual.union(new THREE.Box3().setFromObject(mesh)));
      for (const side of ["min", "max"])
        for (const axis of ["x", "y", "z"]) {
          assert.ok(
            Math.abs(expected[side][axis] - actual[side][axis]) < 0.001,
            `${id}: ${side}.${axis} differs from source shell semantics`,
          );
        }
    } finally {
      dispose(model.group);
    }
  });

  test(`${id}: exterior draws each roof area once, with no near-coplanar extrusion cap`, () => {
    const entranceHall = id === hall.campusId ? hall : null;
    const model = createExterior(campus, {
      hall: entranceHall,
      special: id === special.campusId ? special : null,
    });
    try {
      const source = renderedShells(campus, entranceHall);
      const heights = new Set(source.map((p) => (p.base || 0) + p.height));
      const expectedArea = source.reduce((sum, p) => sum + polygonArea(p), 0);
      let actualArea = 0;
      for (const mesh of model.pickables.filter(
        (mesh) =>
          !mesh.userData.exteriorFeature &&
          mesh.userData.exteriorRole !== "underside",
      ))
        for (const triangle of trianglesOf(mesh)) {
          const ys = triangle.map((v) => v.y),
            low = Math.min(...ys),
            high = Math.max(...ys);
          if (high - low > 0.0001 || high < 0.1) continue;
          assert.ok(
            [...heights].some((h) => Math.abs(h - high) < 0.001),
            `${id}: roof was displaced instead of removing its duplicate cap`,
          );
          actualArea += projectedArea(triangle);
        }
      assert.ok(
        Math.abs(actualArea - expectedArea) <
          Math.max(0.05, expectedArea * 1e-5),
        `${id}: roof triangles cover ${actualArea.toFixed(3)} instead of ${expectedArea.toFixed(3)} square model units`,
      );
    } finally {
      dispose(model.group);
    }
  });
}

test("an elevated pair of adjacent shells has one roof elevation and no parapet across the shared seam", () => {
  const rectangle = (x) => ({
    points: [
      [x, 0],
      [x + 4, 0],
      [x + 4, 4],
      [x, 4],
    ],
    holes: [],
    height: 4,
    base: 2,
  });
  const model = createExterior(
    {
      shells: [rectangle(0), rectangle(4)],
      facadeBands: [],
      specialFeatures: [],
    },
    { photoDetail: true },
  );
  try {
    model.group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(
      new THREE.Vector3(4, 20, 2),
      new THREE.Vector3(0, -1, 0),
    );
    const hits = ray
      .intersectObject(model.group, true)
      .filter((hit) => hit.object.isMesh);
    assert.ok(hits.length);
    assert.ok(
      Math.abs(hits[0].point.y - 6) < 0.001,
      "an internal parapet rises above the shared roof seam",
    );
    assert.ok(
      hits.every((hit) => hit.point.y <= 6.001),
      "shared edge must stay open",
    );
    const outer = new THREE.Raycaster(
      new THREE.Vector3(0, 20, 2),
      new THREE.Vector3(0, -1, 0),
    )
      .intersectObject(model.group, true)
      .filter((hit) => hit.object.isMesh);
    assert.ok(
      outer[0].point.y > 6.1,
      "the physical outer edge must retain its parapet",
    );
  } finally {
    dispose(model.group);
  }
});

test("elevated connections respect user-corrected second-storey placement, closed undersides and clear lower volumes", () => {
  const campus = data.campuses["v-78"];
  const model = createExterior(campus, { photoDetail: true, style });
  try {
    model.group.updateMatrixWorld(true);
    const raised = campus.elevatedConnections.filter(
      (connection) => connection.clearanceConfirmed,
    );
    assert.equal(raised.length, 4);
    const underside = model.pickables.find(
      (mesh) => mesh.userData.exteriorRole === "underside",
    );
    assert.ok(underside);
    const undersideArea = trianglesOf(underside).reduce(
      (sum, triangle) => sum + projectedArea(triangle),
      0,
    );
    assert.ok(
      Math.abs(
        undersideArea - raised.reduce((sum, c) => sum + c.exclusiveArea, 0),
      ) < 0.002,
    );
    for (const connection of campus.elevatedConnections) {
      if (
        ["a-g-source-bridge", "a-v-source-bridge", "a-d-photo-bridge"].includes(
          connection.id,
        )
      ) {
        assert.equal(connection.displayStorey, 2);
        assert.equal(connection.base, 3.6);
        assert.equal(connection.top, 7.2);
        assert.equal(connection.placementEvidence.type, "user-correction");
      } else {
        assert.equal(connection.id, "a-b-photo-bridge");
        assert.equal(connection.base, 7.2);
        assert.equal(connection.top, 10.8);
      }
      const [x, z] = connection.samplePoint;
      const fromAbove = new THREE.Raycaster(
        new THREE.Vector3(x, 30, z),
        new THREE.Vector3(0, -1, 0),
      ).intersectObjects(model.pickables);
      assert.ok(
        Math.abs(fromAbove[0].point.y - connection.top) < 0.001,
        `${connection.label}: source bridge roof must not become an adjacent tower`,
      );
      if (!connection.clearanceConfirmed) {
        assert.ok(
          campus.displayShells.some(
            (p) => inPolygon([x, z], p) && p.base === 0,
          ),
          "unverified clearance must not be carved out",
        );
        continue;
      }
      const fromBelow = new THREE.Raycaster(
        new THREE.Vector3(x, 0.2, z),
        new THREE.Vector3(0, 1, 0),
      ).intersectObjects(model.pickables);
      assert.equal(fromBelow[0]?.object, underside);
      assert.ok(Math.abs(fromBelow[0].point.y - connection.base) < 0.001);
      for (const mesh of model.pickables)
        for (const triangle of trianglesOf(mesh)) {
          const center = triangle
            .reduce((sum, point) => sum.add(point), new THREE.Vector3())
            .divideScalar(3);
          if (
            center.y > 0 &&
            center.y < connection.base - 0.01 &&
            // Float32 wall vertices may fall a few microns inside the shared
            // boundary. Require a small disk strictly inside the opening.
            connection.polygons.some((p) =>
              [
                [0, 0],
                [0.002, 0],
                [-0.002, 0],
                [0, 0.002],
                [0, -0.002],
              ].every(([dx, dz]) =>
                inPolygon([center.x + dx, center.z + dz], p),
              ),
            )
          )
            assert.fail(
              `${connection.label}: geometry fills the lower opening`,
            );
        }
    }
  } finally {
    dispose(model.group);
  }
});

test("the separate entrance roof is visible over its body without a duplicate generic roof", () => {
  const exterior = createExterior(data.campuses[hall.campusId], {
    photoDetail: true,
    style,
    hall,
    special,
  });
  const entrance = createEntranceHall(hall);
  try {
    exterior.group.updateMatrixWorld(true);
    entrance.group.updateMatrixWorld(true);
    const points = hall.volumePolygons.flatMap((p) => p.points),
      xs = points.map((p) => p[0]),
      zs = points.map((p) => p[1]);
    let samples = 0;
    for (let x = Math.min(...xs) + 0.713; x < Math.max(...xs); x += 3.71)
      for (let z = Math.min(...zs) + 0.927; z < Math.max(...zs); z += 3.93) {
        if (!hall.volumePolygons.some((p) => inPolygon([x, z], p))) continue;
        const ray = new THREE.Raycaster(
          new THREE.Vector3(x, 50, z),
          new THREE.Vector3(0, -1, 0),
        );
        const generic = ray.intersectObjects(exterior.pickables, false);
        assert.ok(
          !generic.some((hit) => Math.abs(hit.point.y - hall.height) < 0.1),
          `duplicate generic roof inside entrance at ${x.toFixed(2)}, ${z.toFixed(2)}`,
        );
        const hits = ray
          .intersectObjects(entrance.pickables, false)
          .filter((hit) => Math.abs(hit.point.y - hall.height) < 0.001);
        assert.equal(
          new Set(hits.map((hit) => hit.object.uuid)).size,
          1,
          "the entrance must have one continuous roof surface",
        );
        samples++;
      }
    assert.ok(
      samples > 50,
      "the ray checks must cover the whole broad pavilion",
    );
  } finally {
    dispose(exterior.group);
    dispose(entrance.group);
  }
});

test("detailed campus plus entrance stays within the overview material and triangle budget", () => {
  const exterior = createExterior(data.campuses["v-78"], {
    photoDetail: true,
    style,
    hall,
    special,
  });
  const entrance = createEntranceHall(hall);
  try {
    let calls = 0,
      triangles = 0;
    for (const group of [exterior.group, entrance.group])
      group.traverse((object) => {
        if (!object.geometry) return;
        calls += Array.isArray(object.material)
          ? Math.max(1, object.geometry.groups.length)
          : 1;
        if (object.isMesh)
          triangles +=
            (object.geometry.index?.count ||
              object.geometry.attributes.position.count) / 3;
      });
    assert.ok(
      calls <= 24,
      `overview needs ${calls} material batches; repeated details should share batches`,
    );
    assert.ok(
      triangles <= 100000,
      `overview needs ${triangles} triangles; decorative window boxes or duplicate caps may have returned`,
    );
  } finally {
    dispose(exterior.group);
    dispose(entrance.group);
  }
});

test("the conference hall replaces the old serrated shell with one circular body and one shallow roof", () => {
  const feature = special.features.find((f) => f.id === "conference-hall");
  const model = createExterior(data.campuses[special.campusId], {
    photoDetail: true,
    style,
    hall,
    special,
  });
  try {
    model.group.updateMatrixWorld(true);
    const meshes = model.pickables.filter(
      (mesh) => mesh.userData.exteriorFeature === feature.id,
    );
    const body = meshes.find((mesh) => mesh.userData.role === "body");
    const roof = meshes.find((mesh) => mesh.userData.role === "roof");
    const glazing = meshes.find((mesh) => mesh.userData.role === "glazing");
    assert.ok(
      body && roof && glazing,
      "round body, complete roof and window ribbon must all be present",
    );
    assert.ok(
      trianglesOf(body).every((triangle) => projectedArea(triangle) < 0.0001),
      "the circular body must have no hidden flat roof cap",
    );
    const crownHeight = feature.roof.base + feature.roof.height;
    for (const triangle of trianglesOf(roof)) {
      const ys = triangle.map((point) => point.y);
      if (Math.max(...ys) - Math.min(...ys) < 0.0001) {
        assert.ok(
          Math.abs(ys[0] - crownHeight) < 0.001,
          "only the flat crown should be horizontal",
        );
      }
    }
    const [cx, cz] = feature.center;
    const roofRadius = feature.radius + feature.roof.eaveOverhang;
    for (let i = 0; i < 12; i++) {
      const angle = (i * Math.PI) / 6,
        dx = Math.cos(angle),
        dz = Math.sin(angle);
      const facade = new THREE.Raycaster(
        new THREE.Vector3(
          cx + dx * (feature.radius + 3),
          2,
          cz + dz * (feature.radius + 3),
        ),
        new THREE.Vector3(-dx, 0, -dz),
      ).intersectObject(body, false);
      assert.ok(
        facade.length,
        "the body must be closed all around its circumference",
      );
      assert.ok(
        Math.abs(
          Math.hypot(facade[0].point.x - cx, facade[0].point.z - cz) -
            feature.radius,
        ) < 0.002,
        "lower facade must follow the fitted circle, not room recesses",
      );
      for (const radius of [0, feature.radius * 0.25, feature.radius * 0.7]) {
        const ray = new THREE.Raycaster(
          new THREE.Vector3(cx + dx * radius, 30, cz + dz * radius),
          new THREE.Vector3(0, -1, 0),
        );
        const hits = ray
          .intersectObject(model.group, true)
          .filter(
            (hit) =>
              hit.object.isMesh && hit.point.y >= feature.roof.base - 0.01,
          );
        assert.equal(
          new Set(hits.map((hit) => hit.object.uuid)).size,
          1,
          "no old flat cap or apex cone may remain under the new roof",
        );
        const expectedHeight =
          radius <= feature.roof.topRadius
            ? crownHeight
            : feature.roof.base +
              (feature.roof.height * (roofRadius - radius)) /
                (roofRadius - feature.roof.topRadius);
        assert.ok(
          Math.abs(hits[0].point.y - expectedHeight) < 0.003,
          "roof slope and flat crown must match the feature data",
        );
      }
    }
  } finally {
    dispose(model.group);
  }
});
