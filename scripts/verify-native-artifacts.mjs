import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkMobilePackage } from "./lib/mobile-package.mjs";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const isCapacitorExtra = (name) =>
  name === "cordova.js" ||
  name === "cordova_plugins.js" ||
  name.startsWith("plugins/");

async function directoryInventory(directory, prefix = "") {
  const records = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory())
      records.push(...(await directoryInventory(filename, name)));
    else if (entry.isFile()) {
      const data = await readFile(filename);
      records.push({ path: name, bytes: data.length, sha256: sha256(data) });
    } else throw new Error(`Unsupported resource entry: ${filename}`);
  }
  return records.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

/** Only native-generated extras whose bytes match the synchronized project pass. */
export function compareAssetInventories(expected, actual, nativeSource = []) {
  const expectedByPath = new Map(expected.map((file) => [file.path, file]));
  const actualByPath = new Map(actual.map((file) => [file.path, file]));
  const nativeByPath = new Map(nativeSource.map((file) => [file.path, file]));
  const missing = [];
  const changed = [];
  const extra = [];
  const allowedExtras = [];
  let matching = 0;
  for (const file of expected) {
    const built = actualByPath.get(file.path);
    if (!built) missing.push(file.path);
    else if (built.sha256 !== file.sha256 || built.bytes !== file.bytes)
      changed.push({ path: file.path, expected: file, actual: built });
    else matching++;
  }
  for (const file of actual) {
    if (expectedByPath.has(file.path)) continue;
    const source = nativeByPath.get(file.path);
    if (
      isCapacitorExtra(file.path) &&
      source?.sha256 === file.sha256 &&
      source.bytes === file.bytes
    )
      allowedExtras.push(file);
    else
      extra.push({
        ...file,
        reason: isCapacitorExtra(file.path)
          ? "Native-generated extra is absent from or differs from the synchronized project"
          : "Unexpected packaged resource",
      });
  }
  return {
    ok: !missing.length && !changed.length && !extra.length,
    expectedFiles: expected.length,
    actualFiles: actual.length,
    matching,
    missing,
    changed,
    extra,
    allowedExtras,
  };
}

// AAPT APK entries use UTF-8 names even when the ZIP EFS flag is absent.
// Recover those exact bytes from Python's lossless CP437 fallback, then decode
// strictly as UTF-8. Do not normalize names or substitute replacement characters.
export const androidZipFilenamePython = String.raw`
import collections

def android_zip_filename(info):
    if info.flag_bits & 0x800:
        return info.filename
    return info.filename.encode("cp437").decode("utf-8")

def android_zip_entries(archive):
    entries = [(info, android_zip_filename(info)) for info in archive.infolist() if not info.is_dir()]
    duplicates = [name for name, count in collections.Counter(name for info, name in entries).items() if count > 1]
    if duplicates:
        raise ValueError("Duplicate APK entries: " + repr(duplicates))
    return entries

def android_public_asset_path(name):
    if not name.startswith("assets/public/"):
        return None
    relative = name[len("assets/public/"):]
    if not relative or relative.startswith("/") or "\\" in relative or any(part in (".", "..", "") for part in relative.split("/")):
        raise ValueError("Invalid APK public asset path: " + name)
    return relative
`;

const apkInspectionPython = String.raw`
import hashlib, json, struct, sys, zipfile, zlib
${androidZipFilenamePython}
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = android_zip_entries(archive)
    manifest = archive.read("AndroidManifest.xml")
    if len(manifest) < 8 or struct.unpack_from("<HHI", manifest) != (3, 8, len(manifest)):
        raise ValueError("AndroidManifest.xml is not compiled Android binary XML")
    dex_records = []
    for item, name in entries:
        if "/" not in name and name.startswith("classes") and name.endswith(".dex"):
            dex = archive.read(item)
            if len(dex) < 112 or dex[:4] != b"dex\n" or dex[7] != 0 or not dex[4:7].isdigit():
                raise ValueError("Invalid DEX header: " + name)
            if struct.unpack_from("<I", dex, 32)[0] != len(dex) or struct.unpack_from("<I", dex, 40)[0] != 0x12345678:
                raise ValueError("Invalid DEX size or endianness: " + name)
            if hashlib.sha1(dex[32:]).digest() != dex[12:32] or zlib.adler32(dex[12:]) & 0xffffffff != struct.unpack_from("<I", dex, 8)[0]:
                raise ValueError("DEX integrity check failed: " + name)
            dex_records.append({"path": name, "bytes": len(dex), "version": dex[4:7].decode("ascii"), "sha256": hashlib.sha256(dex).hexdigest()})
    if not dex_records or not any(item["path"] == "classes.dex" for item in dex_records):
        raise ValueError("APK has no classes.dex")
    assets = []
    for item, name in entries:
        relative = android_public_asset_path(name)
        if relative is None:
            continue
        digest = hashlib.sha256()
        with archive.open(item) as stream:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
        assets.append({"path": relative, "bytes": item.file_size, "sha256": digest.hexdigest()})
    if not assets:
        raise ValueError("APK has no bundled public assets")
    print(json.dumps({"format": "Android APK (ZIP)", "filenameEncoding": {"policy": "Strict UTF-8, including entries without ZIP EFS flag; no normalization", "utf8NamesWithoutEFS": [name for info, name in entries if not info.flag_bits & 0x800 and not name.isascii()]}, "manifest": {"format": "Android binary XML", "bytes": len(manifest), "sha256": hashlib.sha256(manifest).hexdigest()}, "dex": dex_records, "assets": sorted(assets, key=lambda item: item["path"])}))
`;

function runJSON(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command}: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`,
    );
  return JSON.parse(result.stdout);
}

async function fileEvidence(filename) {
  const info = await stat(filename);
  if (!info.isFile() || info.size === 0)
    throw new Error(`Missing or empty artifact file: ${filename}`);
  return {
    path: filename,
    bytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    sha256: sha256(await readFile(filename)),
  };
}

export async function verifyNativeArtifacts({ project, apkPath }) {
  const dist = path.join(project, "dist");
  const evidence = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    project,
    scope:
      "Compiled artifact formats and embedded resource equality; does not establish map accuracy or device behavior",
    ok: false,
    errors: [],
  };
  let expected;
  try {
    const descriptor = await checkMobilePackage(project, dist);
    evidence.package = {
      version: descriptor.version,
      campuses: descriptor.campuses,
      dataFiles: descriptor.files.length,
      dataBytes: descriptor.bytes,
    };
    expected = await directoryInventory(dist);
    evidence.dist = { path: dist, files: expected };
  } catch (error) {
    evidence.errors.push(`dist: ${error.message}`);
    return evidence;
  }
  try {
    const file = await fileEvidence(apkPath);
    const inspected = runJSON("python3", ["-c", apkInspectionPython, apkPath]);
    const nativeSource = await directoryInventory(
      path.join(project, "android/app/src/main/assets/public"),
    );
    evidence.android = {
      ...file,
      ...inspected,
      comparison: compareAssetInventories(
        expected,
        inspected.assets,
        nativeSource,
      ),
    };
  } catch (error) {
    evidence.errors.push(`android: ${error.message}`);
  }
  evidence.ok =
    !evidence.errors.length && evidence.android?.comparison.ok === true;
  return evidence;
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--help") {
      console.log(
        "Usage: node scripts/verify-native-artifacts.mjs [--project DIR] [--apk FILE] [--output FILE]",
      );
      return;
    }
    if (
      !["--project", "--apk", "--output"].includes(option) ||
      !args[index + 1]
    )
      throw new Error(`Unknown or incomplete option: ${option}`);
    options[option.slice(2)] = args[++index];
  }
  const project = path.resolve(
    options.project || path.join(import.meta.dirname, ".."),
  );
  const apkPath = path.resolve(
    options.apk ||
      path.join(project, "android/app/build/outputs/apk/debug/app-debug.apk"),
  );
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const output = path.resolve(
    options.output ||
      path.join(
        project,
        ".native-build/verification",
        `native-artifacts-${runId}.json`,
      ),
  );
  const evidence = await verifyNativeArtifacts({ project, apkPath });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    `Native artifact verification ${evidence.ok ? "PASSED" : "FAILED"}: ${output}`,
  );
  const comparison = evidence.android?.comparison;
  if (comparison)
    console.log(
      `Android: ${comparison.matching}/${comparison.expectedFiles} dist files match; ${comparison.missing.length} missing, ${comparison.changed.length} changed, ${comparison.extra.length} unexpected, ${comparison.allowedExtras.length} verified Capacitor extras`,
    );
  for (const error of evidence.errors) console.error(error);
  if (!evidence.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
