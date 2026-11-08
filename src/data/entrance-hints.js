// User-confirmed entrance via the main room; the internal door is not surveyed.
export function entranceHint(room) {
  if (![room?.id, room?.roomId].includes("v-78--floor-3--cux")) return null;
  return {
    label: "Вход через Г-424",
    note: "Сначала найдите Г-424. Точное положение внутренней двери ещё уточняется.",
    viaRoomId: "v-78--floor-3--cvi",
    viaLabel: "Г-424",
  };
}
