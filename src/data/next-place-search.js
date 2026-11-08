import { findPlaces, normalizePlaceQuery } from "./place-search.js";
import { placeLocation } from "./place-location.js";

/** Shared Next search for the main field and route endpoints. Context orders
 * existing results, never hides another wing or borrows a nearby landmark. */
export function findNextPlaces(
  records,
  {
    query = "",
    category = null,
    campusId,
    building,
    floorId,
    physicalLevel,
    manifest,
  } = {},
) {
  const queryKey = normalizePlaceQuery(query);
  const floors = new Map(
    (manifest?.campuses || []).flatMap((campus) =>
      (campus.floors || []).map((floor) => [`${campus.id}:${floor.id}`, floor]),
    ),
  );
  const selectedFloor = floors.get(`${campusId}:${floorId}`);
  const level = Number.isFinite(physicalLevel)
    ? physicalLevel
    : selectedFloor?.buildingLevels?.[building];
  const found =
    queryKey || category
      ? findPlaces(records, { query, category, floorId })
      : records.slice();
  return found
    .map((room, index) => ({
      room,
      index,
      identity: placeLocation(
        room,
        floors.get(`${room.campusId}:${room.floorId}`),
      ),
    }))
    .sort(
      (a, b) =>
        Number(
          Boolean(queryKey) && normalizePlaceQuery(b.room.label) === queryKey,
        ) -
          Number(
            Boolean(queryKey) && normalizePlaceQuery(a.room.label) === queryKey,
          ) ||
        Number(Boolean(campusId) && b.room.campusId === campusId) -
          Number(Boolean(campusId) && a.room.campusId === campusId) ||
        Number(Boolean(building) && b.identity.building === building) -
          Number(Boolean(building) && a.identity.building === building) ||
        Number(Number.isFinite(level) && b.identity.physicalLevel === level) -
          Number(
            Number.isFinite(level) && a.identity.physicalLevel === level,
          ) ||
        Number(Boolean(floorId) && b.room.floorId === floorId) -
          Number(Boolean(floorId) && a.room.floorId === floorId) ||
        a.index - b.index,
    )
    .map(({ room }) => room);
}
