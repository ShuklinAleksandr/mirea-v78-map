import { physicalLevel } from "./utils.js";

const amenityKinds = new Set([
  "cafeteria",
  "toilet",
  "cloakroom",
  "medical",
  "entrance",
]);

const hallPlaces = {
  "v-78--floor-2--9yb": {
    kind: "entrance",
    physicalLevel: 2,
    description:
      "Главный вход и холл сразу после него находятся на 2 этаже. Холл соединяется с корпусом А через группу из четырёх больших дверей, которые по уточнению пользователя открыты настежь.",
  },
  "v-78-floor2-area-6": {
    kind: "unclassified",
    displayKind: "hall",
    label: "Главный холл",
    physicalLevel: 2,
    description:
      "Холл после главного входа на 2 этаже, соединённый с корпусом А через четыре большие открытые двери. Принадлежность самого холла к корпусу ещё уточняется.",
  },
  "v-78--floor-2--9yc": {
    kind: "cloakroom",
    physicalLevel: 2,
    description:
      "Гардеробная в главном холле на 2 этаже. Рядом спуск к коридору с библиотекой и соединением с корпусом И: первый марш к стене главного входа с улицы, затем площадка и разворот на 180°. Физический этаж нижнего коридора и размеры уточняются.",
  },
  ...Object.fromEntries(
    ["v-78--floor-2--9z2", "v-78--floor-2--a05"].map((id) => [
      id,
      {
        kind: "cafeteria",
        label: "Буфет",
        physicalLevel: 2,
        description:
          "Открытый буфет у главной лестницы: со стороны коридора проход без стены, со стороны кабинетов и входного холла перегородки сохраняются. Внутри столы и стойка. Уточнено пользователем; часы работы и меню пока не указаны.",
      },
    ]),
  ),
};

const libraryDescent = {
  kind: "stairs",
  label: "Спуск к библиотеке · корпус И",
  physicalLevel: 2,
  note: "По описанию пользователя: от гардероба первый марш спускается к стене главного входа с улицы, затем промежуточная площадка и разворот на 180°. Дальше коридор с библиотекой и связь с корпусом И. И и ИВЦ — разные корпуса. Размеры, число ступеней, физический этаж и точная привязка нижнего выхода ещё не подтверждены; схема не создаёт нового плана или маршрута.",
};
const nearLibraryPoint = (value, expected) =>
  Array.isArray(value) &&
  value.length >= 2 &&
  Math.hypot(value[0] - expected[0], value[1] - expected[1]) < 0.0001;
function isLibraryDescent(room) {
  const sourceId = "v-78:edge:20734";
  const id = String(room?.id || "");
  const positions = [room?.center, room?.position].filter(Array.isArray);
  if (
    room?.kind !== "stairs" ||
    !(
      id === sourceId ||
      id.startsWith(`${sourceId}@`) ||
      room.sourceIds?.includes(sourceId)
    ) ||
    !positions.length ||
    !positions.every((point) => nearLibraryPoint(point, [30.523, 33.1784]))
  )
    return false;
  if (
    room.targetFloorId &&
    (room.targetFloorId !== "v-78-floor1" ||
      !nearLibraryPoint(room.targetPosition, [40.407, 22.8264]))
  )
    return false;
  return true;
}

function confirmedHallPlace(room, floor) {
  const correction = isLibraryDescent(room)
    ? libraryDescent
    : hallPlaces[room?.roomId || room?.id];
  if (
    !correction ||
    (room?.kind !== correction.kind && room?.kind !== correction.displayKind)
  )
    return null;
  const floorId = floor?.id || room?.floorId;
  if (floorId !== "v-78-floor2") return null;
  return correction;
}

/** User-confirmed display names and physical floor, without changing source data.
 * A connection to A does not establish that the entrance hall belongs to A.
 */
export function presentPlaceIdentity(room, floor = null) {
  const correction = confirmedHallPlace(room, floor);
  if (!correction) return room;
  return {
    ...room,
    floorId: floor?.id || room.floorId,
    kind: correction.displayKind || room.kind,
    label: correction.label || room.label,
    ...(correction === libraryDescent
      ? {
          building: null,
          note:
            room.shapeReviewStatus === "user-confirmed-schematic" && room.note
              ? room.note
              : correction.note,
        }
      : {}),
    placeEvidence: {
      type: "user-confirmed",
      date: "2026-10-25",
      physicalLevel: correction.physicalLevel,
    },
  };
}

/** A source label such as «Медпункт А-109» provides its own building.
 * Unlabelled facilities never borrow a building from a nearby point.
 */
export function placeBuilding(room, floor) {
  if (room?.building) return room.building;
  const label = String(room?.label || "");
  return (
    Object.keys(floor?.buildingLevels || {})
      .sort((a, b) => b.length - a.length)
      .find((building) => {
        const escaped = building.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(
          `(?:^|[\\s(])${escaped}[-−–—]\\d{3}(?:$|[^\\d])`,
          "u",
        ).test(label);
      }) || null
  );
}

const physicalLabel = (value) => (value === -1 ? "Цоколь" : `${value} этаж`);

/** Distinguishes an object's own location from a graph-derived landmark.
 * A landmark describes where to look on the plan, not a surveyed entrance.
 */
export function placeLocation(room, floor, landmarks = null) {
  const building = placeBuilding(room, floor);
  const confirmed = confirmedHallPlace(room, floor);
  const level =
    confirmed?.physicalLevel ??
    (building ? physicalLevel(floor, building) : null);
  const sourceLabel = Number.isFinite(floor?.level)
    ? `Уровень ${floor.level} плана`
    : "Уровень плана не указан";
  const summary = building
    ? `Корпус ${building} · ${level == null ? `этаж уточняется · ${sourceLabel.toLocaleLowerCase("ru")}` : physicalLabel(level)}`
    : level != null
      ? `Корпус уточняется · ${physicalLabel(level)}`
      : `Корпус и этаж уточняются · ${sourceLabel.toLocaleLowerCase("ru")}`;
  const key = room?.roomId || room?.id;
  const landmark = building
    ? null
    : landmarks instanceof Map
      ? landmarks.get(key)
      : landmarks?.[key];
  return {
    building,
    physicalLevel: level,
    sourceLabel,
    summary,
    landmark: landmark
      ? `Ориентир: ${landmark.label} · корпус ${landmark.building} · ${physicalLabel(landmark.physicalLevel).toLocaleLowerCase("ru")}`
      : "",
    landmarkEvidence: landmark || null,
    locationEvidence: confirmed
      ? { type: "user-confirmed", date: "2026-10-25" }
      : null,
  };
}

export function placeDescription(room) {
  const confirmed = confirmedHallPlace(room);
  if (confirmed) return confirmed.description || confirmed.note;
  switch (room?.kind) {
    case "toilet":
      if (/\sЖ$/u.test(room.label)) return "Женский санузел по подписи плана.";
      if (/\sМ$/u.test(room.label)) return "Мужской санузел по подписи плана.";
      if (/\sМЖ$/u.test(room.label))
        return "Санузел с обозначением «МЖ» в исходном плане.";
      return "Санузел по исходному плану. Тип санузла в подписи не указан.";
    case "cafeteria":
      return "Место питания по исходному плану. Часы работы и меню пока не указаны.";
    case "cloakroom":
      return "Гардеробная по подписи исходного плана.";
    case "medical":
      return "Медпункт по подписи исходного плана.";
    case "entrance":
      return "Вход по подписи исходного плана.";
    default:
      return room?.label
        ? "Занятость аудитории не отслеживается."
        : "Назначение помещения пока не уточнено.";
  }
}

class MinHeap {
  values = [];
  push(value) {
    let i = this.values.length;
    this.values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.values[parent].distance <= value.distance) break;
      this.values[i] = this.values[parent];
      i = parent;
    }
    this.values[i] = value;
  }
  pop() {
    const first = this.values[0];
    const last = this.values.pop();
    if (this.values.length) {
      let i = 0;
      while (i * 2 + 1 < this.values.length) {
        let child = i * 2 + 1;
        if (
          child + 1 < this.values.length &&
          this.values[child + 1].distance < this.values[child].distance
        )
          child++;
        if (this.values[child].distance >= last.distance) break;
        this.values[i] = this.values[child];
        i = child;
      }
      this.values[i] = last;
    }
    return first;
  }
}

/** Finds useful numbered landmarks along short, existing horizontal passages.
 * No Euclidean nearest-room guess, stair edge, rejected edge, or shortcut
 * through another named room can supply an association. The input is unchanged.
 */
export function buildPlaceLandmarks(graph, records, { maxDistance = 25 } = {}) {
  const result = new Map();
  if (
    graph?.status !== "source-graph" ||
    !Number.isFinite(maxDistance) ||
    maxDistance < 0
  )
    return result;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const rooms = new Map(
    records
      .filter((room) => room.campusId === graph.campusId)
      .map((room) => [room.id, room]),
  );
  const adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from),
      to = nodes.get(edge.to);
    if (
      !edge.eligible ||
      !["corridor", "door"].includes(edge.kind) ||
      !from ||
      !to ||
      from.floorId !== to.floorId ||
      !Number.isFinite(edge.distanceMeters) ||
      edge.distanceMeters < 0
    )
      continue;
    adjacency.get(from.id).push({ to: to.id, edge });
    if (edge.bidirectional) adjacency.get(to.id).push({ to: from.id, edge });
  }
  for (const room of rooms.values()) {
    if (!amenityKinds.has(room.kind)) continue;
    const source = graph.rooms?.[room.id];
    if (!source || !nodes.has(source.nodeId)) continue;
    const distances = new Map([[source.nodeId, 0]]);
    const previous = new Map();
    const queue = new MinHeap();
    queue.push({ id: source.nodeId, distance: 0 });
    while (queue.values.length) {
      const { id, distance } = queue.pop();
      if (distance > distances.get(id) || distance > maxDistance) continue;
      const node = nodes.get(id);
      if (node.floorId !== room.floorId) continue;
      const target = rooms.get(node.areaId);
      if (target && target.id !== room.id) {
        const floor = graph.floors?.[target.floorId];
        const building = placeBuilding(target, floor);
        const level = building ? physicalLevel(floor, building) : null;
        if (target.kind === "room" && building && level != null) {
          const edgeIds = [];
          let cursor = id;
          while (previous.has(cursor)) {
            const step = previous.get(cursor);
            edgeIds.push(step.edgeId);
            cursor = step.from;
          }
          result.set(room.id, {
            roomId: target.id,
            label: target.label,
            building,
            physicalLevel: level,
            floorId: target.floorId,
            distanceMeters: distance,
            edgeIds: edgeIds.reverse(),
            evidence: "source-horizontal-graph",
          });
          break;
        }
        // Entering another named destination never turns it into a passage.
        continue;
      }
      for (const step of adjacency.get(id)) {
        const distanceTo = distance + step.edge.distanceMeters;
        if (
          distanceTo <= maxDistance &&
          distanceTo < (distances.get(step.to) ?? Infinity)
        ) {
          distances.set(step.to, distanceTo);
          previous.set(step.to, { from: id, edgeId: step.edge.id });
          queue.push({ id: step.to, distance: distanceTo });
        }
      }
    }
  }
  return result;
}
