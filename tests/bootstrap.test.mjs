import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadBootstrapData } from "../src/data/bootstrap.js";
import * as THREE from "three";
import { AtlasScene } from "../src/map/scene.js";

const read = (name) =>
  JSON.parse(
    readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)),
  );
const assets = {
  "/data/manifest.json": read("manifest"),
  "/data/search-index.json": read("search-index"),
  "/data/assumptions.json": read("assumptions"),
};

test("all optional assets may fail while the complete V78 indoor catalog still boots", async () => {
  const data = await loadBootstrapData(async (url) => {
    if (url in assets) return structuredClone(assets[url]);
    throw new Error("503 unavailable");
  });
  assert.deepEqual(
    data.manifest.campuses.map((campus) => campus.id),
    ["v-78"],
  );
  assert.equal(data.manifest.campuses[0].floors.length, 5);
  assert.equal(data.search.length, 1148);
  assert.ok(data.search.every((room) => room.campusId === "v-78"));
  assert.equal(data.unavailable.length, 6);
  assert.deepEqual(data.exterior, { campuses: {} });
  assert.deepEqual(data.photos, { images: [] });
  assert.equal(
    assets["/data/manifest.json"].campuses.length,
    4,
    "source metadata is preserved",
  );
});

test("missing essential plans and invalid model dimensions remain actionable startup errors", async () => {
  for (const required of Object.keys(assets))
    await assert.rejects(
      loadBootstrapData(async (url) => {
        if (url === required) throw new Error(`Failed ${url}`);
        return structuredClone(assets[url] ?? {});
      }),
      /Failed/,
    );
  await assert.rejects(
    loadBootstrapData(async (url) => {
      if (url.endsWith("assumptions.json"))
        return { floorHeight: 0, wallHeight: -2 };
      return structuredClone(assets[url] ?? {});
    }),
    /Параметры модели/,
  );
  await assert.rejects(
    loadBootstrapData(async (url) => {
      if (url.endsWith("manifest.json")) return { campuses: [] };
      return structuredClone(assets[url] ?? {});
    }),
    /Вернадского/,
  );
});

test("stale catalog entries cannot expose removed campuses or missing floors", async () => {
  const data = await loadBootstrapData(async (url) => {
    const value = structuredClone(assets[url] ?? null);
    if (url.endsWith("search-index.json")) {
      const rooms = Array.isArray(value) ? value : value.rooms;
      rooms.push({ id: "stale", campusId: "v-78", floorId: "missing" });
    }
    return value;
  });
  assert.ok(!data.search.some((room) => room.id === "stale"));
  assert.equal(data.search.length, 1148);
  assert.ok(data.unavailable.includes("exterior"));
});

test("the current optional packages all pass structural validation", async () => {
  const data = await loadBootstrapData(async (url) =>
    read(url.replace("/data/", "").replace(/\.json$/, "")),
  );
  assert.deepEqual(data.unavailable, []);
  assert.ok(data.exterior.campuses["v-78"].shells.length);
});

test("a hung optional request reaches its deadline while essential maps still boot", async () => {
  let lateReject;
  const data = await loadBootstrapData(
    async (url) => {
      if (url in assets) return structuredClone(assets[url]);
      if (url.endsWith("photo-index.json"))
        return new Promise((_resolve, reject) => {
          lateReject = reject;
        });
      throw new Error("503 unavailable");
    },
    { optionalTimeoutMs: 10 },
  );
  assert.equal(data.search.length, 1148);
  assert.ok(data.unavailable.includes("photos"));
  assert.deepEqual(data.photos, { images: [] });
  lateReject(new Error("the abandoned request eventually failed"));
  await Promise.resolve();
  assert.deepEqual(data.photos, { images: [] });
});

test("all optional deadlines are cleaned up when essential startup fails", async (t) => {
  const active = new Set();
  const setTimer = globalThis.setTimeout;
  const clearTimer = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const id = setTimer(callback, delay);
    active.add(id);
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id) => {
    active.delete(id);
    return clearTimer(id);
  });
  await assert.rejects(
    loadBootstrapData(async (url) => {
      if (url.endsWith("manifest.json")) throw new Error("essential failed");
      if (url in assets) return structuredClone(assets[url]);
      return new Promise(() => {});
    }),
    /essential failed/,
  );
  assert.equal(active.size, 0);
});

test("malformed optional geometry is rejected before reaching the scene", async () => {
  const damaged = {
    "/data/exterior-shells.json": { campuses: { "v-78": {} } },
    "/data/exterior-context.json": { campusId: "v-78", roads: {} },
    "/data/exterior-hall.json": { campusId: "v-78", lowPolygon: {} },
    "/data/exterior-special.json": { campusId: "v-78", features: {} },
    "/data/facade-style.json": { roofFeatures: {} },
  };
  const data = await loadBootstrapData(async (url) =>
    structuredClone(assets[url] ?? damaged[url] ?? { images: [] }),
  );
  assert.deepEqual(data.unavailable.sort(), [
    "context",
    "exterior",
    "facadeStyle",
    "hall",
    "special",
  ]);
  assert.deepEqual(data.exterior, { campuses: {} });
  assert.equal(data.search.length, 1148);
});

const footprint = {
  points: [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ],
  holes: [],
};
function overviewHarness() {
  const floor = {
    id: "v-78-floor1",
    level: 1,
    footprints: [footprint],
    polygons: [{ ...footprint, id: "room", label: "А-101", kind: "room" }],
  };
  const view = Object.assign(Object.create(AtlasScene.prototype), {
    model: new THREE.Group(),
    context: new THREE.Group(),
    selection: new THREE.Group(),
    hover: new THREE.Group(),
    renderer: { shadowMap: {} },
    labelLayer: { replaceChildren() {} },
    campus: { id: "v-78" },
    floors: [floor],
    floorHeight: 3.6,
    wallHeight: 2.7,
    buildingCenters: {},
    callbacks: {},
    addOutdoor() {},
    addUncertainty() {},
    addLabel() {
      return {};
    },
    fit() {},
    applyTheme() {},
    refreshRoute() {},
  });
  return { view, floor };
}

test("damaged exterior, special, hall or facade falls back to plans and keeps indoor rooms selectable", () => {
  const exterior = {
    campuses: {
      "v-78": {
        shells: [{ ...footprint, height: 3.6 }],
        facadeBands: [],
      },
    },
  };
  for (const damaged of [
    { exterior: { campuses: { "v-78": {} } } },
    { special: { campusId: "v-78", features: {} } },
    {
      hall: { campusId: "v-78", lowPolygon: footprint, volumePolygons: [null] },
    },
    { style: { roofFeatures: {} } },
  ]) {
    const { view, floor } = overviewHarness();
    view.setExterior(
      damaged.exterior ?? exterior,
      null,
      damaged.style,
      damaged.hall,
      damaged.special,
    );
    try {
      assert.doesNotThrow(() => view.setOverview());
      assert.ok(
        view.model.children.some((mesh) => mesh.userData.floor === floor),
        "overview is built from essential floor footprints",
      );
      assert.equal(view.exteriorData["v-78"], null);
      assert.doesNotThrow(() => view.setFloor(floor));
      assert.equal(view.mode, "floor");
      assert.ok(
        view.pickables.some((mesh) =>
          mesh.userData.faceRooms?.some((room) => room.id === "room"),
        ),
      );
    } finally {
      view.clear();
    }
  }
});

test("damaged optional outdoor context cannot discard the main building or indoor map", () => {
  const { view, floor } = overviewHarness();
  view.setExterior({ campuses: {} }, { campusId: "v-78", roads: [{}] });
  try {
    assert.doesNotThrow(() => view.setOverview());
    assert.ok(
      view.model.children.some((mesh) => mesh.userData.floor === floor),
    );
    assert.equal(view.exteriorContext, null);
    assert.doesNotThrow(() => view.setFloor(floor));
    assert.equal(view.mode, "floor");
  } finally {
    view.clear();
  }
});
