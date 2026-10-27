import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { AtlasScene } from "../src/map/scene.js";
import { getHallAdjacencyView } from "../src/map/hall-adjacency.js";

const readFloor = (level) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../public/data/campuses/v-78/v-78-floor${level}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );

function renderConnections(floor, stackDisplay = false, building = "А") {
  const labels = [];
  const view = Object.assign(Object.create(AtlasScene.prototype), {
    model: new THREE.Group(),
    pickables: [],
    assumptions: { floorHeight: 3.6 },
    building,
    neighborsOn: false,
    stackDisplay,
    callbacks: {},
    addLabel(text, point, y, kind, onClick, id) {
      const label = { text, point, y, kind, onClick, id };
      labels.push(label);
      return label;
    },
  });
  // Exercise the complete production path: resolve markers, create the stair,
  // deduplicate, transform, merge materials and assign pickable face owners.
  view.addConnections(floor);
  const layouts = new Set();
  const yByLayout = new Map();
  for (const mesh of view.pickables) {
    const owners = mesh.userData.faceRooms;
    const positions = mesh.geometry.attributes.position;
    assert.equal(positions.count / 3, owners.length);
    for (let face = 0; face < owners.length; face++) {
      const id = owners[face].layoutId;
      if (!id) continue;
      layouts.add(id);
      const range = yByLayout.get(id) || { min: Infinity, max: -Infinity };
      for (let vertex = face * 3; vertex < face * 3 + 3; vertex++) {
        const y = positions.getY(vertex);
        range.min = Math.min(range.min, y);
        range.max = Math.max(range.max, y);
      }
      yByLayout.set(id, range);
    }
  }
  return {
    view,
    labels,
    layouts,
    yByLayout,
    dispose() {
      view.model.traverse((object) => {
        object.geometry?.dispose();
        for (const material of [].concat(object.material || []))
          material.dispose();
      });
    },
  };
}

test("the library return stair survives the real hall display adapter and stacked rendering without a guessed lower duplicate", () => {
  const floor = readFloor(2);
  const source = structuredClone(floor);
  const id = "v-78-floor2-user-stair-library";
  for (const stacked of [false, true]) {
    const result = renderConnections(
      getHallAdjacencyView(floor),
      stacked,
      null,
    );
    try {
      assert.ok(result.layouts.has(id));
      const range = result.yByLayout.get(id);
      assert.ok(range.min < -3 && range.max < 1.1);
      const labels = result.labels.filter(
        (entry) => entry.id === `photo-stair:${id}`,
      );
      assert.equal(labels.length, 1);
      assert.equal(labels[0].text, "Спуск к библиотеке · корпус И");
      assert.equal(labels[0].y, 1.25);
    } finally {
      result.dispose();
    }
  }
  const lower = renderConnections(readFloor(1), false, null);
  try {
    assert.equal(lower.layouts.has(id), false);
  } finally {
    lower.dispose();
  }
  assert.deepEqual(floor, source);
});

test("A1 scene renders the confirmed incoming hall pair and the next IVC descent as separate selectable modules", () => {
  const floor = readFloor(1);
  const source = structuredClone(floor);
  const ascendingId = "v-78-floor1-photo-stair-A154";
  const ivcId = "v-78-floor1-user-stair-basement";
  for (const stacked of [false, true]) {
    const result = renderConnections(floor, stacked);
    try {
      assert.ok(result.layouts.has(ascendingId));
      assert.ok(result.layouts.has(ivcId));
      const ascending = result.yByLayout.get(ascendingId),
        descending = result.yByLayout.get(ivcId);
      assert.ok(
        ascending.min < 0.3 && ascending.max > 4,
        "A2 arrival is real geometry above A1",
      );
      assert.ok(
        descending.min < -3 && descending.max < 1.1,
        "IVC descent remains visible below A1 even in a stack",
      );
      for (const [id, text] of [
        [ascendingId, "Лестница 2 ↔ 1 (по описанию)"],
        [ivcId, "Спуск к ИВЦ (по описанию)"],
      ]) {
        const labels = result.labels.filter(
          (entry) => entry.id === `photo-stair:${id}`,
        );
        assert.equal(labels.length, 1);
        assert.equal(labels[0].text, text);
        assert.equal(
          labels[0].y,
          1.25,
          "scheme labels belong to the current floor",
        );
      }
    } finally {
      result.dispose();
    }
  }
  assert.deepEqual(
    floor,
    source,
    "display modules cannot rewrite source geometry",
  );
});

test("the accepted A3 arrival is present alone but never duplicated in a stacked scene", () => {
  for (const [level, arrivalId] of [[3, "v-78-floor3-photo-stair-wide-hall"]]) {
    const floor = readFloor(level);
    const standalone = renderConnections(floor);
    const stacked = renderConnections(floor, true);
    try {
      assert.ok(standalone.layouts.has(arrivalId));
      assert.ok(standalone.yByLayout.get(arrivalId).min < 0);
      assert.equal(stacked.layouts.has(arrivalId), false);
      assert.ok(
        standalone.labels.some(({ id }) => id === `photo-stair:${arrivalId}`),
      );
      assert.equal(
        stacked.labels.some(({ id }) => id === `photo-stair:${arrivalId}`),
        false,
      );
    } finally {
      standalone.dispose();
      stacked.dispose();
    }
  }
});

test("A2 shows the confirmed descent alone while a stack renders the same module only from A1", () => {
  const floor = readFloor(2),
    id = "v-78-floor2-photo-stair-A154-arrival";
  const standalone = renderConnections(floor),
    stacked = renderConnections(floor, true);
  try {
    assert.ok(standalone.layouts.has(id));
    assert.ok(standalone.yByLayout.get(id).min < -3);
    assert.ok(standalone.yByLayout.get(id).max < 1.1);
    assert.equal(
      stacked.layouts.has(id),
      false,
      "paired physical module is deduplicated",
    );
    const label = standalone.labels.find(
      (entry) => entry.id === `photo-stair:${id}`,
    );
    assert.equal(label.text, "Лестница 2 ↔ 1 (по описанию)");
    assert.equal(label.y, 1.25);
    assert.equal(
      stacked.labels.some((entry) => entry.id === `photo-stair:${id}`),
      false,
    );
  } finally {
    standalone.dispose();
    stacked.dispose();
  }
});

test("the real photographed A146 stair next to the schematic hall branches keeps its flights", () => {
  const result = renderConnections(readFloor(1));
  try {
    const id = "v78-А-1-U у А-146";
    assert.ok(result.layouts.has(id));
    assert.ok(result.yByLayout.get(id).max > 3.5);
    assert.ok(result.labels.some((entry) => entry.id === `photo-stair:${id}`));
  } finally {
    result.dispose();
  }
});

test("last available building plans keep incoming flights pickable below the slab without stacked duplicates", () => {
  for (const [level, building, ids] of [
    [4, "А", ["ЛК-10", "ЛК-9", "ЛК-3", "ЛК-2"]],
    [3, "Б", ["ЛК2", "ЛК3", "ЛК1"]],
    [3, "В", ["ЛК2", "ЛК3", "ЛК1"]],
    [3, "Г", ["ЛК2", "ЛК3", "ЛК1"]],
  ]) {
    const floor = readFloor(level);
    const standalone = renderConnections(floor, false, building);
    const stacked = renderConnections(floor, true, building);
    try {
      for (const name of ids) {
        const id = `v78-${building}-${level}-${name}`;
        assert.ok(standalone.layouts.has(id), id);
        assert.ok(standalone.yByLayout.get(id).min < -3, id);
        assert.ok(standalone.yByLayout.get(id).max < 1.1, id);
        assert.equal(stacked.layouts.has(id), false, id);
        const label = standalone.labels.find(
          (entry) => entry.id === `photo-stair:${id}`,
        );
        assert.ok(label, id);
        assert.equal(
          label.y,
          1.25,
          "arrival label belongs to the current floor",
        );
      }
    } finally {
      standalone.dispose();
      stacked.dispose();
    }
  }
});
