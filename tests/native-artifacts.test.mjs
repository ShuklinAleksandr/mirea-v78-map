import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  androidZipFilenamePython,
  compareAssetInventories,
  inspectSimulatorMachO,
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

function executable(platform = 7, cpu = 16777228) {
  const data = Buffer.alloc(56);
  data.writeUInt32LE(0xfeedfacf, 0);
  data.writeUInt32LE(cpu, 4);
  data.writeUInt32LE(2, 12);
  data.writeUInt32LE(1, 16);
  data.writeUInt32LE(24, 20);
  data.writeUInt32LE(0x32, 32);
  data.writeUInt32LE(24, 36);
  data.writeUInt32LE(platform, 40);
  data.writeUInt32LE(15 << 16, 44);
  data.writeUInt32LE(26 << 16, 48);
  return data;
}

test("Mach-O load commands distinguish Simulator from a physical iPhone executable", () => {
  const inspected = inspectSimulatorMachO(executable());
  assert.equal(inspected.slices[0].architecture, "arm64");
  assert.equal(inspected.slices[0].minimumOS, "15.0.0");
  assert.throws(() => inspectSimulatorMachO(executable(2)), /expected 7/);
  assert.throws(
    () => inspectSimulatorMachO(Buffer.from("not an executable")),
    /Mach-O/,
  );
  const malformed = executable();
  malformed.writeUInt32LE(1000, 36);
  assert.throws(() => inspectSimulatorMachO(malformed), /load-command size/);
});

test("all universal executable slices must target Simulator", () => {
  const arm = executable();
  const intel = executable(7, 16777223);
  const data = Buffer.alloc(48 + arm.length + intel.length);
  data.writeUInt32BE(0xcafebabe, 0);
  data.writeUInt32BE(2, 4);
  data.writeUInt32BE(48, 16);
  data.writeUInt32BE(arm.length, 20);
  data.writeUInt32BE(48 + arm.length, 36);
  data.writeUInt32BE(intel.length, 40);
  arm.copy(data, 48);
  intel.copy(data, 48 + arm.length);
  assert.deepEqual(
    inspectSimulatorMachO(data).slices.map((slice) => slice.architecture),
    ["arm64", "x86_64"],
  );
  executable(2, 16777223).copy(data, 48 + arm.length);
  assert.throws(() => inspectSimulatorMachO(data), /expected 7/);
});
