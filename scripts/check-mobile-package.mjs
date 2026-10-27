import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {
  checkMobilePackage,
  checkNativeBundles,
} from "./lib/mobile-package.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const descriptor = await checkMobilePackage(root, dist);
const nativeRoots = [
  "ios/App/App/public",
  "android/app/src/main/assets/public",
].map((p) => path.join(root, p));
const assetCount = await checkNativeBundles(dist, nativeRoots);
const config = JSON.parse(
  await readFile(path.join(root, "capacitor.config.json"), "utf8"),
);
assert.equal(config.webDir, "dist");
assert.equal(
  config.server?.url,
  undefined,
  "Native app must load local offline assets",
);
console.log(
  `Native V78 bundle integrity OK: ${assetCount} assets, ${descriptor.files.length} data files, ${descriptor.bytes} bytes, version ${descriptor.version}.`,
);
