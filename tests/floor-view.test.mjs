import test from "node:test";
import assert from "node:assert/strict";
import { mergedFloorView } from "../src/data/floor-view.js";

test("returning between loaded floors retains derived-view cache identity without mutating plans", () => {
  const a = Object.freeze({ id: "a", polygons: Object.freeze([]), level: 0 });
  const b = Object.freeze({ id: "b", polygons: Object.freeze([]), level: 1 });
  const meta = Object.freeze({ id: "a", level: 2 });
  const first = mergedFloorView(a, meta);
  mergedFloorView(b, undefined);
  assert.strictEqual(mergedFloorView(a, meta), first);
  assert.strictEqual(first.polygons, a.polygons);
  assert.equal(first.level, 2);
  assert.equal(a.level, 0);
});

test("reloaded plans or changed manifest metadata invalidate the merged view", () => {
  const source = { id: "a", polygons: [] };
  const metadata = { level: 2 };
  const first = mergedFloorView(source, metadata);
  assert.notStrictEqual(mergedFloorView({ ...source }, metadata), first);
  const updated = mergedFloorView(source, { level: 3 });
  assert.notStrictEqual(updated, first);
  assert.equal(updated.level, 3);
});
