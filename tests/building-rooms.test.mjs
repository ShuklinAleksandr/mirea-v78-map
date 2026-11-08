import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildingRoomFloors } from "../src/data/building-rooms.js";

function mapData(name) {
  return JSON.parse(
    readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)),
  );
}

const campus = mapData("manifest").campuses.find(({ id }) => id === "v-78");
const search = mapData("search-index");

test("the building list uses physical floors and only shows classrooms from that building", () => {
  const floors = buildingRoomFloors(campus, "Г", search);
  assert.deepEqual(
    floors.map(({ id, label }) => [id, label]),
    [
      ["v-78-floor0", "1 этаж"],
      ["v-78-floor1", "2 этаж"],
      ["v-78-floor2", "3 этаж"],
      ["v-78-floor3", "4 этаж"],
    ],
  );
  for (const floor of floors)
    for (const room of floor.rooms)
      for (const marker of room.markers) {
        assert.equal(marker.building, "Г");
        assert.equal(marker.campusId, campus.id);
        assert.equal(marker.floorId, floor.id);
        assert.equal(marker.kind, "room");
      }
});

test("a repeated classroom label is listed once while each real map marker stays selectable", () => {
  const floors = buildingRoomFloors(campus, "Г", search);
  const repeated = floors[2].rooms.filter(({ label }) => label === "Г-309");
  assert.equal(repeated.length, 1);
  const ids = repeated[0].markers.map(({ id }) => id).sort();
  assert.deepEqual(ids, [
    "v-78--floor-2--a3d",
    "v-78--floor-2--a40",
    "v-78--floor-2--a4y",
  ]);
});
