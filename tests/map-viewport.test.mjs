import test from "node:test";
import assert from "node:assert/strict";
import {
  measuredLandscapePadding,
  measuredPortraitPadding,
  portraitMapPadding,
} from "../src/ui/map-viewport.js";

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

test("portrait uses one compact top row and reserves the floor button only at the right edge", () => {
  assert.deepEqual(
    measuredPortraitPadding(380, 844, {
      back: rect(8, 8, 44, 44),
      settings: rect(328, 8, 44, 44),
      top: rect(60, 8, 136, 44),
      floorPicker: rect(308, 60, 64, 44),
      tools: rect(328, 295, 44, 194),
      sidebar: rect(8, 788, 364, 48),
    }),
    { left: 16, top: 64, right: 84, bottom: 68 },
  );
});

test("portrait preserves measured safe top and bottom while a longer picker cannot waste half the map width", () => {
  assert.deepEqual(
    measuredPortraitPadding(380, 844, {
      back: rect(8, 52, 44, 44),
      settings: rect(328, 52, 44, 44),
      top: rect(60, 52, 136, 44),
      floorPicker: rect(120, 104, 252, 44),
      tools: rect(328, 295, 44, 194),
      sidebar: rect(8, 754, 364, 48),
    }),
    { left: 16, top: 108, right: 84, bottom: 102 },
  );
});

test("portrait camera fits above the actual open card, route dock or point confirmation", () => {
  assert.deepEqual(
    measuredPortraitPadding(380, 844, {
      top: rect(60, 8, 136, 44),
      sidebar: rect(8, 500, 364, 336),
      dock: rect(8, 560, 364, 276),
      location: rect(12, 690, 356, 80),
    }),
    { left: 16, top: 64, right: 16, bottom: 356 },
  );
});

test("zero-sized and offscreen portrait controls do not reserve obsolete space", () => {
  assert.deepEqual(
    measuredPortraitPadding(380, 844, {
      top: rect(60, 0, 0, 0),
      floorPicker: rect(380, 60, 64, 44),
      tools: rect(328, -200, 44, 194),
      sidebar: rect(8, 844, 364, 48),
    }),
    { left: 16, top: 64, right: 16, bottom: 16 },
  );
});

test("portrait DOM measurement excludes CSS-hidden and hidden-attribute panels", () => {
  const names = ["document", "getComputedStyle", "innerWidth", "innerHeight"];
  const saved = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const element = (box, style = {}, hidden = false) => ({
    hidden,
    style,
    getBoundingClientRect: () => box,
  });
  const elements = new Map([
    [".map-top", element(rect(60, 52, 136, 44))],
    ["#settings-open", element(rect(328, 52, 44, 44))],
    ["#next-floor-open", element(rect(308, 104, 64, 44))],
    [".sidebar", element(rect(8, 700, 364, 136), { visibility: "hidden" })],
    [
      "#route-guidance-dock",
      element(rect(8, 550, 364, 286), { display: "none" }),
    ],
    ["#location-pick-banner", element(rect(8, 600, 364, 100), {}, true)],
  ]);
  try {
    globalThis.document = {
      querySelector: (selector) => elements.get(selector),
    };
    globalThis.getComputedStyle = (item) => item.style;
    globalThis.innerWidth = 380;
    globalThis.innerHeight = 844;
    assert.deepEqual(portraitMapPadding(), {
      left: 16,
      top: 108,
      right: 84,
      bottom: 16,
    });
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
