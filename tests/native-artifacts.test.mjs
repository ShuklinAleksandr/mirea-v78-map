import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  androidZipFilenamePython,
  compareAssetInventories,
} from "../scripts/verify-native-artifacts.mjs";

function runZipRegression(source) {
  const result = spawnSync(
    "python3",
    ["-c", `${androidZipFilenamePython}\n${source}`],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

test("Android ZIP reader preserves exact UTF-8 filenames when AAPT omits the EFS flag", () => {
  const result = runZipRegression(String.raw`
import hashlib, io, json, struct, zipfile
name = "assets/public/data/photos/Снимок экрана\u00a0— 2026-10-19 в\u00a016.44.12.jpg"
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, "w") as archive:
    archive.writestr(name, b"resource bytes")
raw = bytearray(buffer.getvalue())
central = raw.index(b"PK\x01\x02")
struct.pack_into("<H", raw, 6, 0)
struct.pack_into("<H", raw, central + 8, 0)
with zipfile.ZipFile(io.BytesIO(raw)) as archive:
    entries = android_zip_entries(archive)
    info, decoded = entries[0]
    assert info.flag_bits == 0 and info.filename != name
    assert decoded == name
    assert android_public_asset_path(decoded) == name[len("assets/public/"):]
    assert archive.read(info) == b"resource bytes"
    print(json.dumps({"name": decoded, "sha256": hashlib.sha256(archive.read(info)).hexdigest()}))
`);
  assert.equal(
    result.name,
    "assets/public/data/photos/Снимок экрана\u00a0— 2026-10-19 в\u00a016.44.12.jpg",
  );
  assert.equal(result.sha256.length, 64);
});

test("Android ZIP decoding rejects invalid UTF-8 and keeps traversal checks", () => {
  const result = runZipRegression(String.raw`
import json, zipfile
invalid = zipfile.ZipInfo("assets/public/café.txt")
invalid.flag_bits = 0
try:
    android_zip_filename(invalid)
    raise AssertionError("Invalid UTF-8 was accepted")
except UnicodeDecodeError:
    pass
for name in ("assets/public/../secret", "assets/public/a\\b", "assets/public//data.json", "assets/public/./data.json"):
    try:
        android_public_asset_path(name)
        raise AssertionError("Unsafe path was accepted: " + name)
    except ValueError:
        pass
print(json.dumps({"rejected": True}))
`);
  assert.equal(result.rejected, true);
});

test("Android ZIP duplicate detection runs after exact UTF-8 decoding", () => {
  const result = runZipRegression(String.raw`
import json, zipfile
name = "assets/public/Снимок.jpg"
utf8 = zipfile.ZipInfo(name)
utf8.flag_bits = 0x800
unflagged = zipfile.ZipInfo(name.encode("utf-8").decode("cp437"))
unflagged.flag_bits = 0
class Archive:
    def infolist(self):
        return [utf8, unflagged]
try:
    android_zip_entries(Archive())
    raise AssertionError("Duplicate Android filename was accepted")
except ValueError as error:
    assert "Duplicate APK entries" in str(error)
print(json.dumps({"duplicatesRejected": True}))
`);
  assert.equal(result.duplicatesRejected, true);
});

const file = (path, sha256 = "expected", bytes = 10) => ({
  path,
  sha256,
  bytes,
});

test("artifact inventory rejects missing, changed and unexpected production assets", () => {
  const comparison = compareAssetInventories(
    [file("index.html"), file("data/manifest.json"), file("data/v-78.json")],
    [
      file("index.html", "old"),
      file("data/manifest.json"),
      file("data/v-86.json"),
    ],
  );
  assert.equal(comparison.ok, false);
  assert.equal(comparison.matching, 1);
  assert.deepEqual(comparison.missing, ["data/v-78.json"]);
  assert.equal(comparison.changed[0].path, "index.html");
  assert.equal(comparison.extra[0].path, "data/v-86.json");
});

test("Capacitor extras pass only when their hashes match the synchronized native project", () => {
  const dist = [file("index.html")];
  const extras = [
    file("cordova.js"),
    file("cordova_plugins.js"),
    file("plugins/example/www/plugin.js"),
  ];
  const result = compareAssetInventories(dist, [...dist, ...extras], extras);
  assert.equal(result.ok, true);
  assert.equal(result.allowedExtras.length, 3);
  assert.equal(
    compareAssetInventories(dist, [...dist, ...extras], []).ok,
    false,
  );
  assert.equal(
    compareAssetInventories(
      dist,
      [...dist, file("cordova.js", "stale")],
      extras,
    ).ok,
    false,
  );
  const extraData = file("data/old-campus.json");
  assert.equal(
    compareAssetInventories(dist, [...dist, extraData], [extraData]).ok,
    false,
  );
});
