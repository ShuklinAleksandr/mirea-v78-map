import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const RELEASE_CAMPUS_ID = "v-78";

// Source archives remain complete. Only explicitly supported runtime layers are
// shipped, so adding another source campus cannot silently enlarge the release.
const commonFiles = [
  "assumptions.json",
  "exterior-context.json",
  "exterior-hall.json",
  "exterior-overrides.json",
  "exterior-shells.json",
  "exterior-special.json",
  "facade-style.json",
  "lidar/report.json",
  "stair-assumptions.json",
  "stair-layouts.json",
];
const excluded = Symbol("outside release scope");

const jsonBuffer = (value) => Buffer.from(`${JSON.stringify(value)}\n`);

export async function listFiles(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.ok(
      !entry.isSymbolicLink(),
      `Unexpected asset symlink: ${entry.name}`,
    );
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory())
      result.push(
        ...(await listFiles(path.join(directory, entry.name), relative)),
      );
    else if (entry.isFile()) result.push(relative);
    else assert.fail(`Unsupported asset: ${relative}`);
  }
  return result.sort((a, b) => a.localeCompare(b, "en"));
}

function assetPath(url) {
  assert.equal(typeof url, "string", "Asset URL must be a string");
  assert.ok(
    url.startsWith("/data/") &&
      !/[\\?#%]/.test(url) &&
      path.posix.normalize(url) === url &&
      !url.split("/").includes(".."),
    `Unsafe release asset URL: ${url}`,
  );
  return url.slice(1);
}

function scopedDocument(value, floorIds) {
  if (Array.isArray(value))
    return value
      .map((item) => scopedDocument(item, floorIds))
      .filter((item) => item !== excluded);
  if (!value || typeof value !== "object") return value;
  if (
    typeof value.campusId === "string" &&
    value.campusId !== RELEASE_CAMPUS_ID
  )
    return excluded;
  for (const key of ["floorId", "sourceFloorId"])
    if (typeof value[key] === "string" && !floorIds.has(value[key]))
      return excluded;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const scoped =
      key === "campuses" && item && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).filter(([id]) => id === RELEASE_CAMPUS_ID),
          )
        : item;
    const next = scopedDocument(scoped, floorIds);
    if (next !== excluded) result[key] = next;
  }
  return result;
}

function localAssetReferences(value, result = new Set()) {
  if (typeof value === "string" && value.startsWith("/data/"))
    result.add(assetPath(value));
  else if (Array.isArray(value))
    for (const item of value) localAssetReferences(item, result);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) localAssetReferences(item, result);
  return result;
}

// Produce the same projection for the build and for source-vs-bundle integrity
// checks. Selected floor/plan/routing bytes are preserved without re-encoding.
export async function createReleaseData(publicDirectory) {
  const readJSON = async (name) =>
    JSON.parse(
      await readFile(path.join(publicDirectory, "data", name), "utf8"),
    );
  const manifest = await readJSON("manifest.json");
  const campuses = manifest.campuses.filter(
    ({ id }) => id === RELEASE_CAMPUS_ID,
  );
  assert.equal(
    campuses.length,
    1,
    "Release must contain exactly one V78 campus",
  );
  const campus = campuses[0];
  assert.ok(campus.floors.length, "V78 has no floors");
  const floorIds = new Set(campus.floors.map(({ id }) => id));
  assert.equal(floorIds.size, campus.floors.length, "Duplicate V78 floor ID");
  const files = new Map();
  const documents = [];
  const addJSON = (name, document) => {
    assert.notEqual(
      document,
      excluded,
      `Wrong campus for release layer ${name}`,
    );
    files.set(`data/${name}`, jsonBuffer(document));
    documents.push(document);
  };
  const addAsset = async (url, expectedPrefix) => {
    const filename = assetPath(url);
    if (expectedPrefix)
      assert.ok(
        filename.startsWith(expectedPrefix),
        `Asset is outside release campus: ${filename}`,
      );
    if (!files.has(filename))
      files.set(filename, await readFile(path.join(publicDirectory, filename)));
  };

  addJSON("manifest.json", {
    ...manifest,
    title: "РТУ МИРЭА · Вернадского, 78",
    campuses,
  });
  const search = await readJSON("search-index.json");
  addJSON(
    "search-index.json",
    search.filter(
      (item) =>
        item.campusId === RELEASE_CAMPUS_ID && floorIds.has(item.floorId),
    ),
  );
  for (const floor of campus.floors) {
    await addAsset(floor.url, `data/campuses/${RELEASE_CAMPUS_ID}/`);
    const document = JSON.parse(files.get(assetPath(floor.url)).toString());
    assert.equal(document.campusId, RELEASE_CAMPUS_ID);
    assert.equal(document.id, floor.id);
    documents.push(document);
    await addAsset(floor.sourcePlanUrl, `data/plans/${RELEASE_CAMPUS_ID}/`);
  }
  const routeUrl = `/data/routing/${RELEASE_CAMPUS_ID}.json`;
  await addAsset(routeUrl);
  const routing = JSON.parse(files.get(assetPath(routeUrl)).toString());
  assert.equal(routing.campusId, RELEASE_CAMPUS_ID);
  documents.push(routing);

  for (const name of commonFiles)
    addJSON(name, scopedDocument(await readJSON(name), floorIds));

  const photos = await readJSON("photo-index.json");
  // The legacy index identifies its campus once, by address. New records may
  // carry an explicit campusId; those are filtered independently.
  assert.ok(
    photos.campusId === RELEASE_CAMPUS_ID ||
      /Вернадского\s*,?\s*78(?:\D|$)/u.test(photos.address || ""),
    "Photo index must explicitly identify Vernadskogo 78",
  );
  const images = scopedDocument(photos.images, floorIds);
  addJSON("photo-index.json", {
    ...photos,
    campusId: RELEASE_CAMPUS_ID,
    sourceCount: images.length,
    images,
  });
  for (const photo of images) await addAsset(photo.file, "data/photos/");

  const references = new Set();
  for (const document of documents) localAssetReferences(document, references);
  for (const reference of references)
    assert.ok(files.has(reference), `Missing release asset: ${reference}`);
  return files;
}

function inside(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function assertReleaseOutput(projectRoot, outputDirectory) {
  const root = path.resolve(projectRoot);
  const output = path.resolve(outputDirectory);
  assert.ok(
    !inside(root, output),
    "Release output cannot contain project sources",
  );
  for (const name of [
    "public",
    "source",
    "src",
    "scripts",
    "tests",
    "node_modules",
  ])
    assert.ok(
      !inside(output, path.join(root, name)),
      `Refusing to replace source data inside ${name}`,
    );
  return output;
}

export async function writeReleaseData(projectRoot, outputDirectory) {
  const output = assertReleaseOutput(projectRoot, outputDirectory);
  const files = await createReleaseData(path.join(projectRoot, "public"));
  await mkdir(output, { recursive: true });
  // Resolve an existing output symlink/junction before any recursive removal.
  assertReleaseOutput(await realpath(projectRoot), await realpath(output));
  const target = path.resolve(output, "data");
  assert.equal(path.dirname(target), output, "Invalid release data target");
  // This is exclusively the generated output/data directory. Replacing it also
  // removes data left by earlier multi-campus builds, including unlisted files.
  await rm(target, { recursive: true, force: true });
  for (const [filename, content] of files) {
    const full = path.join(output, filename);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return files;
}

export function releaseDataPlugin() {
  let config;
  return {
    name: "mirea-v78-release-data",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
    },
    async writeBundle() {
      assert.equal(
        path.resolve(config.publicDir),
        path.resolve(config.root, "public"),
      );
      await writeReleaseData(
        config.root,
        path.resolve(config.root, config.build.outDir),
      );
    },
  };
}
