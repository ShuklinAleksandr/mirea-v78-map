// User confirmed the whole G-424 group is inside G-424 on 2026-11-08.
// These are catalogue IDs, not interchangeable native graph-area suffixes.
const g424Rooms = new Set([
  "v-78--floor-3--cux",
  "v-78--floor-3--cv0",
  "v-78--floor-3--cv1",
  "v-78--floor-3--cvf",
  "v-78--floor-3--cv6",
]);
export function entranceHint(room) {
  if (![room?.id, room?.roomId].some((id) => g424Rooms.has(id))) return null;
  return {
    label: "Вход через Г-424",
    note: "Сначала найдите Г-424. Точное положение внутренней двери ещё уточняется.",
    viaRoomId: "v-78--floor-3--cvi",
    viaLabel: "Г-424",
  };
}
