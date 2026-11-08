import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { stripJpegMetadata } from "../scripts/lib/jpeg-metadata.mjs";
import { createReleaseData } from "../scripts/lib/release-data.mjs";

const segment = (marker, content) => {
  const body = Buffer.from(content);
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([header, body]);
};
const exif = (orientation, big = false) => {
  const tiff = Buffer.alloc(26);
  tiff.write(big ? "MM" : "II");
  const word = (n, offset) =>
    big ? tiff.writeUInt16BE(n, offset) : tiff.writeUInt16LE(n, offset);
  const dword = (n, offset) =>
    big ? tiff.writeUInt32BE(n, offset) : tiff.writeUInt32LE(n, offset);
  word(42, 2);
  dword(8, 4);
  word(1, 8);
  word(0x112, 10);
  word(3, 12);
  dword(1, 14);
  word(orientation, 18);
  return segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0"), tiff]));
};
const begin = Buffer.from([0xff, 0xd8]);
const end = Buffer.from([0xff, 0xd9]);
const scan = segment(0xda, [1, 1, 0, 0, 63, 0]);
const entropy = Buffer.from([7, 0xff, 0, 9, 0xff, 0xd0, 12]);
const coding = segment(0xdb, [0, 1, 2, 3]);
const jfif = segment(0xe0, "JFIF\0test");
const icc = segment(0xe2, "ICC_PROFILE\0test");
const image = (...metadata) =>
  Buffer.concat([begin, jfif, icc, ...metadata, coding, scan, entropy, end]);

test("JPEG metadata stripping preserves JFIF, ICC, coding tables, compressed bytes and source buffer", () => {
  const source = image(
    exif(1),
    segment(0xe1, "http://ns.adobe.com/xap/1.0/\0private XMP"),
    segment(0xed, "Photoshop IPTC private"),
    segment(0xfe, "private comment"),
  );
  const original = Buffer.from(source);
  const clean = stripJpegMetadata(source);
  assert.deepEqual(clean, image());
  assert.deepEqual(source, original);
  assert.equal(stripJpegMetadata(clean), clean);
  assert.deepEqual(stripJpegMetadata(image(exif(1, true))), clean);
});

test("metadata between progressive scans is removed while scan headers and restart escapes survive", () => {
  const prefix = Buffer.concat([begin, coding, scan, entropy]);
  const suffix = Buffer.concat([scan, entropy, end]);
  assert.deepEqual(
    stripJpegMetadata(
      Buffer.concat([
        prefix,
        segment(0xfe, "private"),
        segment(0xe1, "XMP"),
        suffix,
      ]),
    ),
    Buffer.concat([prefix, suffix]),
  );
});

test("unsupported orientation and malformed JPEG/EXIF fail closed", () => {
  for (const orientation of [0, 2, 3, 4, 5, 6, 7, 8])
    for (const big of [false, true])
      assert.throws(
        () => stripJpegMetadata(image(exif(orientation, big))),
        /orientation must be normalized/,
      );
  for (const bad of [
    Buffer.from("not JPEG"),
    image().subarray(0, 8),
    image().subarray(0, -2),
    Buffer.concat([image(), Buffer.from("private appended data")]),
    image(segment(0xe1, "Exif\0\0bad")),
    Buffer.concat([begin, end]),
  ])
    assert.throws(() => stripJpegMetadata(bad));
});

// Read only the header before the first scan. For the real source photos, all
// metadata occurs there; comparing the remaining bytes proves no scan changed.
function headerParts(bytes) {
  let offset = 2;
  const parts = [];
  while (offset < bytes.length) {
    assert.equal(bytes[offset], 0xff);
    const marker = bytes[offset + 1];
    if (marker === 0xda) return { parts, compressed: bytes.subarray(offset) };
    const end = offset + 2 + bytes.readUInt16BE(offset + 2);
    parts.push({ marker, bytes: bytes.subarray(offset, end) });
    offset = end;
  }
  assert.fail("No photo scan");
}

test("all 58 release photos lose metadata without changing original files or compressed image bytes", async () => {
  const publicRoot = new URL("../public/", import.meta.url);
  const index = JSON.parse(
    await readFile(new URL("data/photo-index.json", publicRoot)),
  );
  const originals = new Map(
    await Promise.all(
      index.images.map(async ({ file }) => [
        file.slice(1),
        await readFile(new URL(file.slice(1), publicRoot)),
      ]),
    ),
  );
  const release = await createReleaseData(fileURLToPath(publicRoot));
  assert.equal(originals.size, 58);
  let removed = 0;
  for (const [filename, original] of originals) {
    const clean = release.get(filename);
    const before = headerParts(original),
      after = headerParts(clean);
    assert.ok(
      after.parts.every(({ marker }) => ![0xe1, 0xed, 0xfe].includes(marker)),
      filename,
    );
    assert.deepEqual(
      after.compressed,
      before.compressed,
      `${filename}: encoded image unchanged`,
    );
    assert.deepEqual(
      after.parts,
      before.parts.filter(({ marker }) => ![0xe1, 0xed, 0xfe].includes(marker)),
      `${filename}: rendering headers unchanged`,
    );
    assert.equal(stripJpegMetadata(clean), clean);
    assert.equal(
      createHash("sha256")
        .update(await readFile(new URL(filename, publicRoot)))
        .digest("hex"),
      createHash("sha256").update(original).digest("hex"),
    );
    removed += original.length - clean.length;
  }
  assert.ok(removed > 0);
});
