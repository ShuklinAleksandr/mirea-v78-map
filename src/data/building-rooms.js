import { placeBuilding } from "./place-location.js";
import { levelLabel, physicalLevel } from "./utils.js";

const roomOrder = new Intl.Collator("ru", { numeric: true });

/** Group repeated labels without losing their individual plan markers. */
export function buildingRoomFloors(campus, building, search) {
  if (!campus || !building) return [];
  const floors = new Map(
    campus.floors.map((floor) => [floor.id, { floor, groups: new Map() }]),
  );
  for (const room of search) {
    if (
      room.kind !== "room" ||
      room.campusId !== campus.id ||
      !room.id ||
      typeof room.label !== "string" ||
      !room.label.trim()
    )
      continue;
    const entry = floors.get(room.floorId);
    if (!entry || placeBuilding(room, entry.floor) !== building) continue;

    const label = room.label.trim().normalize("NFC");
    const key = label.toLocaleLowerCase("ru");
    if (!entry.groups.has(key))
      entry.groups.set(key, { label, markers: new Map() });
    entry.groups.get(key).markers.set(room.id, room);
  }
  return [...floors.values()]
    .filter(({ groups }) => groups.size)
    .sort(
      (a, b) =>
        (physicalLevel(a.floor, building) ?? Infinity) -
          (physicalLevel(b.floor, building) ?? Infinity) ||
        a.floor.level - b.floor.level,
    )
    .map(({ floor, groups }) => ({
      id: floor.id,
      label: levelLabel(floor, building),
      rooms: [...groups.values()]
        .sort((a, b) => roomOrder.compare(a.label, b.label))
        .map(({ label, markers }) => ({
          label,
          markers: [...markers.values()],
        })),
    }));
}
