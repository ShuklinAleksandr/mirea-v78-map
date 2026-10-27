import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findPlaces } from "../src/data/place-search.js";

const source = JSON.parse(
  readFileSync(new URL("../public/data/search-index.json", import.meta.url)),
);
const records = (Array.isArray(source) ? source : source.rooms).filter(
  (room) => room.campusId === "v-78",
);

test("room numbers accept Latin letters and separators and put the exact room first", () => {
  assert.equal(findPlaces(records, { query: "g 103.1" })[0].label, "Г-103-1");
  assert.equal(findPlaces(records, { query: "Г—209" })[0].label, "Г-209");
  assert.deepEqual(findPlaces(records), []);
});

test("useful place categories use verified types instead of guesses from room numbers", () => {
  for (const [category, count] of [
    ["cafeteria", 6],
    ["toilet", 94],
    ["cloakroom", 2],
    ["medical", 1],
    ["entrance", 1],
  ]) {
    const results = findPlaces(records, { category });
    assert.equal(results.length, count);
    assert.ok(results.every((room) => room.kind === category));
  }
  assert.equal(findPlaces(records, { query: "еда" }).length, 6);
  assert.equal(findPlaces(records, { query: "санузел" }).length, 94);
  assert.deepEqual(
    findPlaces(records, { category: "toilet", query: "Г-209" }),
    [],
  );
});

test("the current floor is prioritized without pretending that the phone location is known", () => {
  const results = findPlaces(records, {
    category: "toilet",
    floorId: "v-78-floor2",
  });
  const count = results.filter((room) => room.floorId === "v-78-floor2").length;
  assert.ok(count > 0 && count < results.length);
  assert.ok(
    results.slice(0, count).every((room) => room.floorId === "v-78-floor2"),
  );
  assert.ok(
    results.slice(count).every((room) => room.floorId !== "v-78-floor2"),
  );
});
