import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const read = (url) => JSON.parse(readFileSync(asset(url), "utf8"));
function asset(url) {
  assert.ok(url.startsWith("/data/"), `Unexpected public asset URL: ${url}`);
  const path = resolve(root, decodeURIComponent(url.split(/[?#]/)[0]).slice(1));
  assert.ok(
    !relative(root, path).startsWith(".."),
    `Asset escapes public: ${url}`,
  );
  assert.ok(statSync(path).isFile(), `Missing asset: ${url}`);
  assert.ok(statSync(path).size > 0, `Empty asset: ${url}`);
  return path;
}
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() ? files(child) : [child];
  });
}
function leaves(value, visit, key = "") {
  if (Array.isArray(value)) value.forEach((item) => leaves(item, visit, key));
  else if (value && typeof value === "object")
    Object.entries(value).forEach(([name, item]) => leaves(item, visit, name));
  else visit(value, key);
}
const manifest = read("/data/manifest.json");
const photos = read("/data/photo-index.json");
const photoById = new Map(photos.images.map((photo) => [photo.id, photo]));
const floors = manifest.campuses.flatMap((campus) =>
  campus.floors.map((summary) => ({
    campus,
    summary,
    data: read(summary.url),
  })),
);

function jpegDimensions(bytes) {
  assert.equal(bytes.readUInt16BE(0), 0xffd8, "JPEG SOI signature missing");
  assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9, "Truncated JPEG");
  let offset = 2;
  while (offset < bytes.length - 4) {
    assert.equal(bytes[offset], 0xff, "Invalid JPEG segment marker");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    const length = bytes.readUInt16BE(offset);
    assert.ok(length >= 2 && offset + length <= bytes.length);
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    )
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
      };
    assert.notEqual(marker, 0xda, "JPEG has no frame dimensions");
    offset += length;
  }
  assert.fail("JPEG dimensions unavailable");
}

test("all 23 manifest floors and their source SVGs are shipped with matching identities", () => {
  assert.equal(manifest.campuses.length, 4);
  assert.equal(floors.length, 23);
  assert.equal(new Set(floors.map(({ summary }) => summary.url)).size, 23);
  for (const { campus, summary, data } of floors) {
    assert.equal(data.id, summary.id);
    assert.equal(data.campusId, campus.id);
    const svg = readFileSync(asset(summary.sourcePlanUrl), "utf8");
    assert.match(svg, /<svg\b/);
    assert.match(svg, /<\/svg>\s*$/);
    assert.ok(
      svg.length > 1000,
      `Source plan is unexpectedly empty: ${summary.id}`,
    );
  }
});

test("all 58 gallery entries point to complete JPEGs with the indexed dimensions", () => {
  assert.equal(photos.sourceCount, 58);
  assert.equal(photos.images.length, 58);
  assert.equal(photoById.size, 58);
  assert.equal(new Set(photos.images.map((photo) => photo.file)).size, 58);
  for (const photo of photos.images) {
    assert.match(photo.file, /\.jpg$/i);
    const bytes = readFileSync(asset(photo.file));
    assert.ok(bytes.length > 1000, photo.id);
    assert.deepEqual(jpegDimensions(bytes), photo.dimensions, photo.id);
    assert.ok(photo.originalFile && photo.caption, photo.id);
    if (photo.sourceGroup === "2gis-reference")
      assert.equal(photo.kind, "map-screenshot", photo.id);
    else
      assert.ok(
        photoById.has(photo.sourceGroup),
        `Missing photo group ${photo.sourceGroup}`,
      );
  }
});

test("optional atlas layers have no broken public asset or source-photo references", () => {
  // Check every published JSON, not just the assets fetched on the initial view.
  // Historical relative LiDAR paths are audit records, not runtime asset URLs.
  for (const path of files(resolve(root, "data")).filter(
    (path) => extname(path) === ".json",
  )) {
    const data = JSON.parse(readFileSync(path, "utf8"));
    leaves(data, (value, key) => {
      if (typeof value !== "string") return;
      if (value.startsWith("/data/")) asset(value);
      if (
        [
          "sourcePhotoId",
          "sourcePhotoIds",
          "photoId",
          "additionalPhotoIds",
        ].includes(key)
      )
        assert.ok(
          photoById.has(value),
          `Unknown photo ${value} in ${relative(root, path)}`,
        );
    });
  }
  const stairs = read("/data/stair-layouts.json");
  for (const layout of stairs.layouts) {
    for (const id of layout.sourcePhotoIds) {
      const photo = photoById.get(id);
      assert.equal(photo.building, layout.building, layout.id);
      assert.equal(photo.floor, layout.physicalFloor, layout.id);
    }
  }
});

test("the public application contains no LiDAR model binaries", () => {
  const models = files(root).filter((path) =>
    /\.(?:glb|gltf|obj|ply|las|laz)$/i.test(path),
  );
  assert.deepEqual(
    models,
    [],
    "Keep unregistered scans in source/lidar, outside public",
  );
});

test("every shipped wall and door has finite distinct endpoints", () => {
  let walls = 0,
    doors = 0;
  for (const { data } of floors) {
    for (const kind of ["walls", "doors"]) {
      for (const segment of data[kind]) {
        for (const point of [segment.a, segment.b]) {
          assert.equal(point.length, 2, `${data.id} ${kind}`);
          assert.ok(point.every(Number.isFinite), `${data.id} ${kind}`);
        }
        assert.ok(
          Math.hypot(segment.a[0] - segment.b[0], segment.a[1] - segment.b[1]) >
            1e-6,
          `Degenerate ${kind} segment in ${data.id}`,
        );
      }
    }
    walls += data.walls.length;
    doors += data.doors.length;
  }
  assert.ok(walls > 0 && doors > 0);
});
