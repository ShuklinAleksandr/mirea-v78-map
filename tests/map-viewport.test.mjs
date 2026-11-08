import test from "node:test";
import assert from "node:assert/strict";
import { measuredLandscapePadding } from "../src/ui/map-viewport.js";

const rect = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

test("a collapsed landscape search frees map width and the vertical floor rail does not consume map height", () => {
  assert.deepEqual(
    measuredLandscapePadding(844, 390, {
      sidebar: rect(8, 60, 44, 44),
      top: rect(60, 8, 140, 44),
      floors: rect(732, 60, 52, 230),
      tools: rect(792, 60, 44, 200),
    }),
    { left: 64, top: 64, right: 124, bottom: 16 },
  );
});

test("landscape camera reserves the visible route card when search is fully hidden", () => {
  assert.deepEqual(
    measuredLandscapePadding(844, 390, {
      sidebar: null,
      dock: rect(8, 60, 262, 260),
      top: rect(0, 0, 0, 0),
      floorPicker: rect(570, 8, 210, 44),
      tools: rect(792, 60, 44, 200),
    }),
    { left: 282, top: 64, right: 64, bottom: 16 },
  );
});

test("opening the search panel or location confirmation reserves its actual edges", () => {
  assert.deepEqual(
    measuredLandscapePadding(844, 390, {
      sidebar: rect(8, 60, 262, 322),
      dock: null,
      top: rect(60, 8, 140, 44),
      location: rect(282, 318, 430, 64),
    }),
    { left: 282, top: 64, right: 16, bottom: 84 },
  );
});
