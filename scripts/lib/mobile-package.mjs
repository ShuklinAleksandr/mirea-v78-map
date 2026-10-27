import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createReleaseData,
  listFiles,
  RELEASE_CAMPUS_ID,
} from "./release-data.mjs";

const hash = (data) => createHash("sha256").update(data).digest("hex");
const sortPaths = (values) => values.sort((a, b) => a.localeCompare(b, "en"));

async function describeReleaseData(projectRoot, outputDirectory) {
  const expected = await createReleaseData(path.join(projectRoot, "public"));
  const actualPaths = (await listFiles(path.join(outputDirectory, "data"))).map(
    (filename) => `data/${filename}`,
  );
  const expectedPaths = sortPaths([...expected.keys()]);
  assert.deepEqual(
    actualPaths,
    expectedPaths,
    "Release data inventory differs from V78 source projection; rebuild the app",
  );
  const files = [];
  for (const filename of expectedPaths) {
    const data = await readFile(path.join(outputDirectory, filename));
    const source = expected.get(filename);
    assert.equal(
      hash(data),
      hash(source),
      `Release data is stale or out of scope: ${filename}`,
    );
    files.push({ path: filename, bytes: data.length, sha256: hash(data) });
  }
  const manifest = JSON.parse(expected.get("data/manifest.json").toString());
  return {
    schemaVersion: 1,
    version: hash(JSON.stringify(files)).slice(0, 16),
    delivery: "bundled",
    updatePolicy: "atomic-app-update",
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    campuses: manifest.campuses.map(({ id, title, floors }) => ({
      id,
      title,
      floors: floors.length,
    })),
    files,
  };
}

export async function writeMobilePackage(projectRoot, outputDirectory) {
  const descriptor = await describeReleaseData(projectRoot, outputDirectory);
  await writeFile(
    path.join(outputDirectory, "mobile-package.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
  return descriptor;
}

export async function checkMobilePackage(projectRoot, outputDirectory) {
  const actual = JSON.parse(
    await readFile(path.join(outputDirectory, "mobile-package.json"), "utf8"),
  );
  const expected = await describeReleaseData(projectRoot, outputDirectory);
  assert.deepEqual(
    actual,
    expected,
    "Mobile descriptor differs from the current V78 bundle",
  );
  assert.deepEqual(
    actual.campuses.map(({ id }) => id),
    [RELEASE_CAMPUS_ID],
  );
  return actual;
}

export async function checkNativeBundles(outputDirectory, nativeRoots) {
  const files = await listFiles(outputDirectory);
  const expectedDataFiles = files.filter((filename) =>
    filename.startsWith("data/"),
  );
  for (const nativeRoot of nativeRoots) {
    const nativeDataFiles = (
      await listFiles(path.join(nativeRoot, "data"))
    ).map((filename) => `data/${filename}`);
    assert.deepEqual(
      nativeDataFiles,
      expectedDataFiles,
      `${nativeRoot}: stale or extra map data; run mobile:sync`,
    );
  }
  for (const filename of files) {
    const expected = hash(await readFile(path.join(outputDirectory, filename)));
    for (const nativeRoot of nativeRoots)
      assert.equal(
        hash(await readFile(path.join(nativeRoot, filename))),
        expected,
        `${nativeRoot}: stale ${filename}; run mobile:sync`,
      );
  }
  return files.length;
}
