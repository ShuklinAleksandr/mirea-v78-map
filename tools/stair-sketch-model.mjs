export const WIDTH = 1600;
export const HEIGHT = 1000;
export const SHEETS = [
  { id: "entrance", title: "Холл · 2 этаж" },
  { id: "lower", title: "Площадка / поворот" },
  { id: "exit", title: "Выход к ИВЦ · отметка не установлена" },
];

export function createProject() {
  return {
    format: "mirea-stair-sketch",
    version: 1,
    sheets: SHEETS.map(({ id }) => ({
      id,
      background: "grid",
      marks: [],
      note: "",
    })),
  };
}

const coordinate = (number, max) => {
  if (!Number.isFinite(number))
    throw new Error("В схеме есть неверные координаты.");
  return Math.max(0, Math.min(max, number));
};
const point = (p) => {
  if (!p || typeof p !== "object")
    throw new Error("В схеме отсутствует точка.");
  return { x: coordinate(p.x, WIDTH), y: coordinate(p.y, HEIGHT) };
};
export function parseProject(text) {
  const value = JSON.parse(text);
  if (value?.format !== "mirea-stair-sketch" || value.version !== 1)
    throw new Error("Это не файл схемы лестницы МИРЭА версии 1.");
  if (!Array.isArray(value.sheets) || value.sheets.length !== SHEETS.length)
    throw new Error("В схеме должны быть три листа.");
  let totalPoints = 0;
  const sheets = SHEETS.map(({ id }) => {
    const matching = value.sheets.filter((sheet) => sheet?.id === id);
    if (matching.length !== 1) throw new Error("Набор листов схемы повреждён.");
    const sheet = matching[0];
    if (!Array.isArray(sheet.marks) || sheet.marks.length > 10000)
      throw new Error("Слишком много элементов на одном листе.");
    const background = sheet.background;
    if (
      !["grid", "hall", "main"].includes(background) &&
      !(
        typeof background === "string" &&
        /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(background)
      )
    )
      throw new Error(
        "Подложка должна быть одним из снимков или локальным изображением.",
      );
    const marks = sheet.marks.map((mark) => {
      if (!mark || !["pen", "arrow", "rect", "text"].includes(mark.type))
        throw new Error("Неизвестный элемент схемы.");
      const color = /^#[0-9a-f]{6}$/i.test(mark.color) ? mark.color : "#152d48";
      if (mark.type === "text")
        return {
          type: "text",
          color,
          at: point(mark.at),
          text: String(mark.text ?? "").slice(0, 160),
        };
      if (mark.type === "pen") {
        if (!Array.isArray(mark.points) || !mark.points.length)
          throw new Error("В линии отсутствуют точки.");
        totalPoints += mark.points.length;
        if (totalPoints > 300000) throw new Error("Схема слишком большая.");
        return { type: "pen", color, points: mark.points.map(point) };
      }
      return {
        type: mark.type,
        color,
        from: point(mark.from),
        to: point(mark.to),
      };
    });
    return {
      id,
      background,
      note: String(sheet.note ?? "").slice(0, 2000),
      marks,
    };
  });
  return { format: "mirea-stair-sketch", version: 1, sheets };
}

export const serializeProject = (project) => JSON.stringify(project, null, 2);
