import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  macBuildPreflight,
  mobileMacBuildPlan,
  runMacBuildPlan,
  verifyMacBuildArtifacts,
} from "../scripts/build-mobile-macos.mjs";

const project = fileURLToPath(new URL("..", import.meta.url));

function readyProbe(command, args) {
  if (command === "npm") return { status: 0, stdout: "11.6.0\n" };
  if (command === "xcodebuild")
    return { status: 0, stdout: "Xcode 26.3\nBuild version 17C100" };
  if (command === "xcrun" && args[0] === "--sdk")
    return {
      status: 0,
      stdout:
        "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator.sdk\n",
    };
  if (command === "xcrun")
    return {
      status: 0,
      stdout: JSON.stringify({
        runtimes: [
          {
            isAvailable: true,
            identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-2",
          },
        ],
      }),
    };
  return { status: 0, stderr: 'openjdk version "21.0.12" 2026-07-21 LTS' };
}

function preflightOptions(probe = readyProbe) {
  return {
    project,
    platform: "darwin",
    nodeVersion: "24.19.0",
    env: { ANDROID_HOME: path.resolve("sdk-test-fixture") },
    probe,
    inspectSdk: (sdk) => ({ sdk, ok: true, checks: [] }),
    executable: () => true,
  };
}

test("Mac build plan syncs once and uses native commands without repeated web builds", () => {
  const plan = mobileMacBuildPlan("/node");
  assert.deepEqual(
    plan.map((step) => step.id),
    ["tests", "sync", "integrity", "android", "ios"],
  );
  assert.equal(
    plan.filter((step) => step.args.includes("mobile:sync")).length,
    1,
  );
  assert.equal(
    plan.some((step) =>
      step.args.some((arg) =>
        ["mobile:build:ios", "mobile:build:android"].includes(arg),
      ),
    ),
    false,
  );
  assert.deepEqual(plan.find((step) => step.id === "android").args, [
    "scripts/build-android.mjs",
  ]);
  const ios = plan.find((step) => step.id === "ios");
  assert.equal(ios.args[ios.args.indexOf("-sdk") + 1], "iphonesimulator");
  assert.ok(ios.args.includes("CODE_SIGNING_ALLOWED=NO"));
  assert.equal(ios.args.includes("archive"), false);
});

test("Mac preflight refuses Windows before probing or starting build commands", () => {
  let probed = false;
  const result = macBuildPreflight({
    project,
    platform: "win32",
    probe: () => {
      probed = true;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(probed, false);
  assert.match(result.checks[0].detail, /Mac/);
});

test("Mac preflight rejects old Xcode and explains full Xcode setup", () => {
  const result = macBuildPreflight(
    preflightOptions((command, args, options) =>
      command === "xcodebuild"
        ? { status: 0, stdout: "Xcode 25.4" }
        : readyProbe(command, args, options),
    ),
  );
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.id === "xcode").ok, false);
  assert.match(
    result.checks.find((check) => check.id === "xcode").detail,
    /26\+/,
  );
});

test("missing Simulator runtime is advisory for generic Simulator compilation", () => {
  const result = macBuildPreflight(
    preflightOptions((command, args, options) =>
      command === "xcrun" && args[0] === "simctl"
        ? { status: 0, stdout: '{"runtimes":[]}' }
        : readyProbe(command, args, options),
    ),
  );
  assert.equal(result.ok, true);
  const runtime = result.checks.find(
    (check) => check.id === "simulator-runtime",
  );
  assert.equal(runtime.ok, false);
  assert.equal(runtime.required, false);
  assert.match(runtime.detail, /запуска/);
});

test("failed native stage stops orchestration and does not claim either artifact", async () => {
  const executed = [];
  let verified = false;
  const result = await runMacBuildPlan(mobileMacBuildPlan(), {
    execute: async (step) => {
      executed.push(step.id);
      return { code: step.id === "android" ? 1 : 0, signal: null };
    },
    verifyArtifacts: async () => {
      verified = true;
      return [];
    },
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(executed, ["tests", "sync", "integrity", "android"]);
  assert.equal(
    result.steps.find((step) => step.id === "ios").status,
    "not-run",
  );
  assert.equal(verified, false);
  assert.deepEqual(result.artifacts, []);
});

test("successful command statuses cannot hide missing compiled outputs", async () => {
  const result = await runMacBuildPlan(mobileMacBuildPlan(), {
    execute: async () => ({ code: 0, signal: null }),
    verifyArtifacts: async () => {
      throw new Error("APK missing");
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error, "APK missing");
  assert.deepEqual(result.artifacts, []);
});

test("orchestration records ordered stages and labels the iOS output as Simulator", async () => {
  const snapshots = [];
  const artifacts = [
    { platform: "android", kind: "debug-apk" },
    { platform: "ios", kind: "simulator-app" },
  ];
  const result = await runMacBuildPlan(mobileMacBuildPlan(), {
    execute: async () => ({ code: 0, signal: null }),
    verifyArtifacts: async () => artifacts,
    onStatus: async (state) => snapshots.push(structuredClone(state)),
  });
  assert.equal(result.status, "passed");
  assert.ok(result.steps.every((step) => step.status === "passed"));
  assert.equal(result.artifacts[1].kind, "simulator-app");
  assert.equal(
    snapshots[0].steps.every((step) => step.status === "pending"),
    true,
  );
  assert.equal(snapshots.at(-1).status, "passed");
});

test("artifact filesystem check requires nonempty APK and Simulator bundle files", async (t) => {
  const temp = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temp, "mirea-mac-artifact-test-"));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(verifyMacBuildArtifacts(root), /app-debug\.apk/);
  const apk = path.join(
    root,
    "android/app/build/outputs/apk/debug/app-debug.apk",
  );
  await mkdir(path.dirname(apk), { recursive: true });
  await writeFile(apk, "filesystem fixture");
  await assert.rejects(verifyMacBuildArtifacts(root), /Info\.plist/);
  const app = path.join(
    root,
    ".native-build/ios/Build/Products/Debug-iphonesimulator/App.app",
  );
  await mkdir(app, { recursive: true });
  await writeFile(path.join(app, "Info.plist"), "filesystem fixture");
  await writeFile(path.join(app, "App"), "");
  await assert.rejects(verifyMacBuildArtifacts(root), /App\.app/);
});
