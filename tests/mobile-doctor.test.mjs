import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSupportedJava,
  inspectAndroidSdk,
  readAndroidRequirements,
  androidSdkCandidates,
  selectAndroidSdk,
} from "../scripts/mobile-doctor.mjs";

test("mobile doctor rejects successful Java 8 and Java 17 commands", () => {
  for (const version of [
    'java version "1.8.0_471"\nJava(TM) SE Runtime Environment',
    'openjdk version "17.0.16" 2025-07-15\nOpenJDK Runtime Environment',
  ]) {
    assert.equal(isSupportedJava({ status: 0, stderr: version }), false);
  }
});

test("mobile doctor accepts JDK 21 and newer from either output stream", () => {
  for (const version of [
    'openjdk version "21.0.12" 2026-07-21 LTS',
    'java version "21.0.9" 2025-10-21 LTS',
    "openjdk 25 2025-09-16\nOpenJDK Runtime Environment",
  ]) {
    for (const stream of ["stdout", "stderr"]) {
      assert.equal(isSupportedJava({ status: 0, [stream]: version }), true);
    }
  }
});

test("mobile doctor rejects missing, failed and unrecognized Java runtimes", () => {
  for (const result of [
    { status: 1, stderr: 'openjdk version "21.0.12"' },
    { status: null, error: new Error("spawn java ENOENT") },
    { status: 0, stdout: "not a Java version" },
    { status: 0, stdout: "" },
  ]) {
    assert.equal(isSupportedJava(result), false);
  }
});

const sdkRequirements = { compileSdk: 36, buildTools: "35.0.0", agp: "8.13.0" };

async function sdkFixture(t, { platform = "win32", omitted = [] } = {}) {
  const temporaryDirectory = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryDirectory, "mirea-sdk-test-"));
  t.after(async () => {
    assert.equal(path.dirname(root), temporaryDirectory);
    await rm(root, { recursive: true, force: true });
  });
  const executable = platform === "win32" ? ".exe" : "";
  const script = platform === "win32" ? ".bat" : "";
  const contents = {
    "platforms/android-36/android.jar": "platform fixture",
    "platforms/android-36/core-for-system-modules.jar": "platform fixture",
    "build-tools/35.0.0/source.properties": "Pkg.Revision=35.0.0\n",
    [`platform-tools/adb${executable}`]: "binary fixture",
    ...Object.fromEntries(
      [
        `aapt2${executable}`,
        `aidl${executable}`,
        `zipalign${executable}`,
        `d8${script}`,
        `apksigner${script}`,
      ].map((name) => [`build-tools/35.0.0/${name}`, "binary fixture"]),
    ),
  };
  for (const [name, content] of Object.entries(contents)) {
    if (omitted.includes(name)) continue;
    const destination = path.join(root, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  return root;
}

const runningTool = (command) => ({
  status: 0,
  stdout: path.basename(command).startsWith("adb")
    ? "Android Debug Bridge version 1.0.41"
    : "Android Asset Packaging Tool (aapt) 2.19",
});

test("doctor reads API 36 and AGP's actual Build Tools 35 default from this project", () => {
  const project = fileURLToPath(new URL("..", import.meta.url));
  assert.deepEqual(readAndroidRequirements(project), sdkRequirements);
});

test("Mac-only SDK is rejected on Windows without trying foreign binaries", async (t) => {
  const sdk = await sdkFixture(t, { platform: "darwin" });
  const calls = [];
  const result = inspectAndroidSdk(sdk, sdkRequirements, {
    platform: "win32",
    runCommand: (...args) => {
      calls.push(args);
      return runningTool(args[0]);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
  for (const name of ["adb", "aapt2 (Build Tools 35.0.0)"])
    assert.equal(result.checks.find((check) => check.label === name).ok, false);
});

test("incomplete SDK reports the missing platform and build tools", async (t) => {
  const sdk = await sdkFixture(t, {
    omitted: [
      "platforms/android-36/android.jar",
      "build-tools/35.0.0/d8.bat",
      "build-tools/35.0.0/aapt2.exe",
    ],
  });
  const result = inspectAndroidSdk(sdk, sdkRequirements, {
    platform: "win32",
    runCommand: runningTool,
  });
  assert.equal(result.ok, false);
  const failures = result.checks.filter((check) => !check.ok);
  assert.equal(failures.length, 3);
  assert.match(
    failures.map((check) => check.detail).join("\n"),
    /android\.jar/,
  );
  assert.match(failures.map((check) => check.detail).join("\n"), /d8\.bat/);
  assert.match(failures.map((check) => check.detail).join("\n"), /aapt2\.exe/);
});

test("SDK with executable names but incompatible binaries is rejected", async (t) => {
  const sdk = await sdkFixture(t);
  const result = inspectAndroidSdk(sdk, sdkRequirements, {
    platform: "win32",
    runCommand: () => ({ status: null, error: new Error("spawn ENOEXEC") }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.filter((check) => !check.ok).length, 2);
});

test("complete host SDK runs adb and aapt2 version checks", async (t) => {
  const sdk = await sdkFixture(t);
  const calls = [];
  const result = inspectAndroidSdk(sdk, sdkRequirements, {
    platform: "win32",
    runCommand: (command, args) => {
      calls.push([path.basename(command), args]);
      return runningTool(command);
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["adb.exe", ["version"]],
    ["aapt2.exe", ["version"]],
  ]);
});

test("automatic SDK selection skips Mac tools and chooses a runnable Windows SDK", async (t) => {
  const macSdk = await sdkFixture(t, { platform: "darwin" });
  const windowsSdk = await sdkFixture(t);
  const selected = selectAndroidSdk(
    [
      { sdk: macSdk, source: "project" },
      { sdk: windowsSdk, source: "Android Studio" },
    ],
    (sdk) =>
      inspectAndroidSdk(sdk, sdkRequirements, {
        platform: "win32",
        runCommand: runningTool,
      }),
  );
  assert.equal(selected.ok, true);
  assert.equal(selected.sdk, windowsSdk);
  assert.equal(selected.rejected.length, 1);
  assert.equal(selected.rejected[0].sdk, macSdk);
});

test("an explicitly invalid ANDROID_HOME is reported instead of silently replaced", async (t) => {
  const validSdk = await sdkFixture(t);
  const invalidSdk = path.join(validSdk, "missing-sdk");
  const candidates = androidSdkCandidates(path.dirname(validSdk), {
    platform: "win32",
    env: { ANDROID_HOME: invalidSdk, ANDROID_SDK_ROOT: validSdk },
  });
  const selected = selectAndroidSdk(candidates, (sdk) =>
    inspectAndroidSdk(sdk, sdkRequirements, {
      platform: "win32",
      runCommand: runningTool,
    }),
  );
  assert.equal(candidates.length, 1);
  assert.equal(selected.ok, false);
  assert.equal(selected.rejected.length, 1);
  assert.equal(selected.rejected[0].sdk, invalidSdk);
  assert.equal(selected.rejected[0].source, "ANDROID_HOME");
  assert.equal(selected.rejected[0].explicit, true);
});

test("Windows SDK candidates include Android Studio's LOCALAPPDATA location", () => {
  const project = path.resolve("project-fixture");
  const localAppData = path.resolve("appdata-fixture");
  const candidates = androidSdkCandidates(project, {
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    home: path.resolve("home-fixture"),
  });
  assert.equal(
    candidates.find((candidate) => candidate.source === "Android Studio").sdk,
    path.join(localAppData, "Android/Sdk"),
  );
  assert.equal(
    candidates.some((candidate) => candidate.sdk.includes("Library")),
    false,
  );
});
