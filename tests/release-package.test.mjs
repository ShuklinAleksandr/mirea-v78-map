import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
  assertReleaseOutput,
  createReleaseData,
  listFiles,
  releaseDataPlugin,
  writeReleaseData,
} from "../scripts/lib/release-data.mjs";
import {
  checkMobilePackage,
  checkNativeBundles,
  writeMobilePackage,
} from "../scripts/lib/mobile-package.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const json = (data) => JSON.stringify(data);
const readJSON = async (filename) =>
  JSON.parse(await readFile(filename, "utf8"));

async function put(root, filename, content) {
  const target = path.join(root, filename);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function fixture(t) {
  const temporary = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "mirea-release-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(temporary), await realpath(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith("mirea-release-"));
    await rm(temporary, { recursive: true, force: true });
  });
  const root = path.join(temporary, "project");
  const selected = { campusId: "v-78", floorId: "v-78-floor0" };
  const other = { campusId: "v-86", floorId: "v-86-floor0" };
  const sources = {
    "manifest.json": {
      schemaVersion: 1,
      campuses: ["v-78", "v-86"].map((id) => ({
        id,
        title: id,
        floors: [
          {
            id: `${id}-floor0`,
            url: `/data/campuses/${id}/${id}-floor0.json`,
            sourcePlanUrl: `/data/plans/${id}/${id}-floor0.svg`,
          },
        ],
      })),
    },
    "search-index.json": [
      { ...selected, id: "selected" },
      { ...other, id: "other" },
    ],
    "assumptions.json": { floorHeight: 3.6 },
    "exterior-context.json": { campusId: "v-78", buildings: [] },
    "exterior-hall.json": { ...selected },
    "exterior-overrides.json": { overrides: [selected, other] },
    "exterior-shells.json": {
      campuses: { "v-78": { shells: [] }, "v-86": { shells: [] } },
    },
    "exterior-special.json": { campusId: "v-78", features: [] },
    "facade-style.json": { campusId: "v-78" },
    "lidar/report.json": { registration: { appliedToCampus: false } },
    "stair-assumptions.json": { layoutsUrl: "/data/stair-layouts.json" },
    "stair-layouts.json": {
      layouts: [selected, other],
      unresolved: [{ floorId: selected.floorId }, { floorId: other.floorId }],
    },
    "photo-index.json": {
      address: "Москва, проспект Вернадского, 78",
      sourceCount: 2,
      images: [
        {
          id: "v78-photo",
          campusId: "v-78",
          file: "/data/photos/selected.jpg",
        },
        { id: "other-photo", campusId: "v-86", file: "/data/photos/other.jpg" },
      ],
    },
    "routing/v-78.json": { campusId: "v-78", nodes: [] },
    "routing/v-86.json": { campusId: "v-86", nodes: [] },
    "campuses/v-78/v-78-floor0.json": {
      id: selected.floorId,
      campusId: "v-78",
    },
    "campuses/v-86/v-86-floor0.json": { id: other.floorId, campusId: "v-86" },
  };
  for (const [filename, content] of Object.entries(sources))
    await put(root, `public/data/${filename}`, json(content));
  for (const id of ["v-78", "v-86"])
    await put(
      root,
      `public/data/plans/${id}/${id}-floor0.svg`,
      `<svg id="${id}"/>`,
    );
  await put(root, "public/data/photos/selected.jpg", "selected photo");
  await put(root, "public/data/photos/other.jpg", "other photo");
  await put(root, "public/data/unreviewed-campus.json", json(other));
  await put(
    root,
    "index.html",
    "<!doctype html><html><body>Release fixture</body></html>",
  );
  return { root, output: path.join(root, "dist"), selected, other };
}

test("the complete source archive projects to all five V78 floors and no other campus", async () => {
  const publicRoot = path.join(project, "public");
  const sourceManifest = await readJSON(
    path.join(publicRoot, "data/manifest.json"),
  );
  assert.equal(sourceManifest.campuses.length, 4);
  const files = await createReleaseData(publicRoot);
  const manifest = JSON.parse(files.get("data/manifest.json"));
  assert.deepEqual(
    manifest.campuses.map(({ id }) => id),
    ["v-78"],
  );
  assert.equal(manifest.campuses[0].floors.length, 5);
  for (const filename of files.keys())
    assert.doesNotMatch(filename, /(?:v-86|mp-1|s-20)/);
  const sourceSearch = await readJSON(
    path.join(publicRoot, "data/search-index.json"),
  );
  assert.deepEqual(
    JSON.parse(files.get("data/search-index.json")),
    sourceSearch.filter(({ campusId }) => campusId === "v-78"),
  );
  assert.deepEqual(
    Object.keys(JSON.parse(files.get("data/exterior-shells.json")).campuses),
    ["v-78"],
  );
  assert.equal(
    JSON.parse(files.get("data/photo-index.json")).images.length,
    58,
  );
  for (const floor of manifest.campuses[0].floors)
    for (const url of [floor.url, floor.sourcePlanUrl])
      assert.deepEqual(
        files.get(url.slice(1)),
        await readFile(path.join(publicRoot, url.slice(1))),
      );
  assert.deepEqual(
    await readJSON(path.join(publicRoot, "data/manifest.json")),
    sourceManifest,
  );
});

test("release projection scopes optional layers and excludes unused photos and unreviewed files", async (t) => {
  const f = await fixture(t);
  const files = await createReleaseData(path.join(f.root, "public"));
  for (const filename of [
    "data/photos/other.jpg",
    "data/unreviewed-campus.json",
    "data/routing/v-86.json",
  ])
    assert.equal(files.has(filename), false, filename);
  const stairs = JSON.parse(files.get("data/stair-layouts.json"));
  assert.deepEqual(stairs.layouts, [f.selected]);
  assert.deepEqual(stairs.unresolved, [{ floorId: "v-78-floor0" }]);
  assert.deepEqual(
    JSON.parse(files.get("data/exterior-overrides.json")).overrides,
    [f.selected],
  );
  const photos = JSON.parse(files.get("data/photo-index.json"));
  assert.equal(photos.sourceCount, 1);
  assert.deepEqual(
    photos.images.map(({ id }) => id),
    ["v78-photo"],
  );
});

test("release replacement removes stale copied data and refuses source directories", async (t) => {
  const f = await fixture(t);
  await mkdir(f.output, { recursive: true });
  await cp(path.join(f.root, "public/data"), path.join(f.output, "data"), {
    recursive: true,
  });
  await writeReleaseData(f.root, f.output);
  const filenames = await listFiles(path.join(f.output, "data"));
  assert.ok(filenames.length);
  assert.ok(
    filenames.every(
      (name) => !name.includes("v-86") && name !== "photos/other.jpg",
    ),
  );
  assert.throws(
    () => assertReleaseOutput(f.root, path.join(f.root, "public")),
    /source data/,
  );
  assert.throws(
    () => assertReleaseOutput(f.root, f.root),
    /contain project sources/,
  );
  assert.equal(
    (await readJSON(path.join(f.root, "public/data/manifest.json"))).campuses
      .length,
    2,
  );
});

test("unsafe or missing selected assets fail before replacing an existing output", async (t) => {
  const f = await fixture(t);
  await put(f.output, "data/previous.txt", "previous successful build");
  const manifest = await readJSON(
    path.join(f.root, "public/data/manifest.json"),
  );
  manifest.campuses[0].floors[0].url = "/data/campuses/v-78/../../escape.json";
  await put(f.root, "public/data/manifest.json", json(manifest));
  await assert.rejects(
    writeReleaseData(f.root, f.output),
    /Unsafe release asset URL/,
  );
  assert.equal(
    await readFile(path.join(f.output, "data/previous.txt"), "utf8"),
    "previous successful build",
  );
});

test("mobile descriptor verifies projected source changes, missing files, and changed descriptor bytes", async (t) => {
  const f = await fixture(t);
  await writeReleaseData(f.root, f.output);
  const descriptor = await writeMobilePackage(f.root, f.output);
  assert.deepEqual(descriptor.campuses, [
    { id: "v-78", title: "v-78", floors: 1 },
  ]);
  assert.deepEqual(await checkMobilePackage(f.root, f.output), descriptor);
  // Rebuilding an excluded campus must not invalidate the V78 app package.
  await put(f.root, "public/data/routing/v-86.json", "changed foreign routing");
  const sourceSearch = await readJSON(
    path.join(f.root, "public/data/search-index.json"),
  );
  sourceSearch.push({ ...f.other, id: "another-excluded-room" });
  await put(f.root, "public/data/search-index.json", json(sourceSearch));
  assert.deepEqual(await checkMobilePackage(f.root, f.output), descriptor);
  await put(f.root, "public/data/photos/selected.jpg", "updated source photo");
  await assert.rejects(
    checkMobilePackage(f.root, f.output),
    /stale or out of scope/,
  );
  await writeReleaseData(f.root, f.output);
  await writeMobilePackage(f.root, f.output);
  const changed = await readJSON(path.join(f.output, "mobile-package.json"));
  changed.bytes += 1;
  await put(f.output, "mobile-package.json", json(changed));
  await assert.rejects(
    checkMobilePackage(f.root, f.output),
    /descriptor differs/,
  );
  await writeMobilePackage(f.root, f.output);
  await rm(path.join(f.output, "data/photos/selected.jpg"));
  await assert.rejects(
    checkMobilePackage(f.root, f.output),
    /inventory differs/,
  );
});

test("native integrity rejects old campus files even when every expected asset matches", async (t) => {
  const f = await fixture(t);
  await writeReleaseData(f.root, f.output);
  await writeMobilePackage(f.root, f.output);
  await put(f.output, "index.html", "release app");
  const nativeRoots = [
    path.join(f.root, "ios-copy"),
    path.join(f.root, "android-copy"),
  ];
  for (const native of nativeRoots) {
    await cp(f.output, native, { recursive: true });
    await put(native, "cordova.js", "native-only bridge");
  }
  await checkNativeBundles(f.output, nativeRoots);
  const stale = "data/campuses/v-86/old-floor.json";
  await put(nativeRoots[0], stale, "old campus");
  await assert.rejects(
    checkNativeBundles(f.output, nativeRoots),
    /stale or extra map data/,
  );
  await rm(path.join(nativeRoots[0], stale));
  await put(nativeRoots[1], "index.html", "outdated app");
  await assert.rejects(
    checkNativeBundles(f.output, nativeRoots),
    /stale index.html/,
  );
});

test(
  "a fresh Vite rebuild always re-applies V78 scope after public data is regenerated",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const options = {
      configFile: false,
      root: f.root,
      logLevel: "silent",
      plugins: [releaseDataPlugin()],
      build: { outDir: "dist", emptyOutDir: true },
    };
    await build(options);
    await writeMobilePackage(f.root, f.output);
    await checkMobilePackage(f.root, f.output);
    const sourceSearch = [
      { ...f.selected, id: "new-v78-room" },
      { ...f.other, id: "regenerated-other-campus" },
    ];
    await put(f.root, "public/data/search-index.json", json(sourceSearch));
    await put(
      f.root,
      "public/data/campuses/v-86/new-floor.json",
      "regenerated foreign data",
    );
    await build(options);
    await writeMobilePackage(f.root, f.output);
    await checkMobilePackage(f.root, f.output);
    assert.deepEqual(
      await readJSON(path.join(f.output, "data/search-index.json")),
      [sourceSearch[0]],
    );
    assert.ok(
      (await listFiles(path.join(f.output, "data"))).every(
        (name) => !name.includes("v-86"),
      ),
    );
    assert.equal(
      (await readJSON(path.join(f.root, "public/data/manifest.json"))).campuses
        .length,
      2,
    );
  },
);
