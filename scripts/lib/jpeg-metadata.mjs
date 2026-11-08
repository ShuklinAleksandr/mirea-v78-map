import assert from "node:assert/strict";

function assertUprightExif(payload) {
  if (!payload.subarray(0, 6).equals(Buffer.from("Exif\0\0"))) return;
  const tiff = payload.subarray(6);
  assert.ok(tiff.length >= 8, "Truncated JPEG EXIF header");
  const endian = tiff.toString("ascii", 0, 2);
  assert.ok(endian === "II" || endian === "MM", "Invalid JPEG EXIF byte order");
  const uint16 = (offset) => {
    assert.ok(
      offset >= 0 && offset + 2 <= tiff.length,
      "Truncated JPEG EXIF value",
    );
    return endian === "II"
      ? tiff.readUInt16LE(offset)
      : tiff.readUInt16BE(offset);
  };
  const uint32 = (offset) => {
    assert.ok(
      offset >= 0 && offset + 4 <= tiff.length,
      "Truncated JPEG EXIF value",
    );
    return endian === "II"
      ? tiff.readUInt32LE(offset)
      : tiff.readUInt32BE(offset);
  };
  assert.equal(uint16(2), 42, "Unsupported JPEG EXIF TIFF format");
  const ifd = uint32(4);
  assert.ok(ifd >= 8, "Invalid JPEG EXIF directory offset");
  const count = uint16(ifd);
  assert.ok(
    ifd + 2 + count * 12 + 4 <= tiff.length,
    "Truncated JPEG EXIF directory",
  );
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (uint16(entry) !== 0x112) continue;
    assert.ok(
      uint16(entry + 2) === 3 && uint32(entry + 4) === 1,
      "Unsupported JPEG EXIF orientation format",
    );
    assert.equal(
      uint16(entry + 8),
      1,
      "JPEG orientation must be normalized before publishing; source was not changed",
    );
  }
}

// Remove metadata segments, never decode/re-encode image samples. APP0/JFIF,
// APP2/ICC and all coding tables/scan bytes remain byte-for-byte unchanged.
export function stripJpegMetadata(input) {
  assert.ok(Buffer.isBuffer(input), "JPEG input must be a Buffer");
  assert.ok(
    input.length >= 4 && input[0] === 0xff && input[1] === 0xd8,
    "Invalid JPEG start",
  );
  const pieces = [input.subarray(0, 2)];
  let offset = 2,
    scans = 0,
    removed = false;
  while (offset < input.length) {
    const start = offset;
    assert.equal(input[offset++], 0xff, "Invalid JPEG marker");
    while (input[offset] === 0xff) offset++;
    assert.ok(offset < input.length, "Truncated JPEG marker");
    const marker = input[offset++];
    if (marker === 0xd9) {
      assert.ok(scans > 0, "JPEG has no image scan");
      assert.equal(offset, input.length, "Unexpected data after JPEG end");
      pieces.push(input.subarray(start, offset));
      return removed ? Buffer.concat(pieces) : input;
    }
    assert.ok(
      marker !== 0 && marker !== 0xd8 && !(marker >= 0xd0 && marker <= 0xd7),
      "Unexpected JPEG standalone marker",
    );
    assert.ok(offset + 2 <= input.length, "Truncated JPEG segment length");
    const length = input.readUInt16BE(offset);
    assert.ok(
      length >= 2 && offset + length <= input.length,
      "Truncated JPEG segment",
    );
    const end = offset + length;
    const metadata = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (marker === 0xe1) assertUprightExif(input.subarray(offset + 2, end));
    if (metadata) removed = true;
    else pieces.push(input.subarray(start, end));
    offset = end;
    if (marker !== 0xda) continue;
    scans++;
    const scanStart = offset;
    // Entropy-coded FF00 escapes and restart markers belong to the image.
    // A later real marker can start another progressive scan or metadata.
    while (offset < input.length) {
      if (input[offset] !== 0xff) {
        offset++;
        continue;
      }
      let next = offset + 1;
      while (input[next] === 0xff) next++;
      assert.ok(next < input.length, "Truncated JPEG scan marker");
      if (input[next] === 0 || (input[next] >= 0xd0 && input[next] <= 0xd7)) {
        offset = next + 1;
        continue;
      }
      break;
    }
    pieces.push(input.subarray(scanStart, offset));
  }
  assert.fail("JPEG is missing its end marker");
}
