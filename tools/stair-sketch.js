import {
  WIDTH,
  HEIGHT,
  SHEETS,
  createProject,
  parseProject,
  serializeProject,
} from "./stair-sketch-model.mjs";

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const context = canvas.getContext("2d");
const storageKey = "mirea-v78-stair-sketch-v1";
const imageCache = new Map();
const imageSources = {
  hall: "/docs/evidence/2026-10-25/user-02-hall.png",
  main: "/docs/evidence/2026-10-25/user-03-main-stairs.png",
};
let project = createProject();
let sheetId = "entrance";
let tool = "pen";
let color = "#c64532";
let pending = null;
let pointerId = null;
const histories = new Map(SHEETS.map(({ id }) => [id, []]));
const current = () => project.sheets.find(({ id }) => id === sheetId);
const message = (text) => {
  $("status").textContent = text;
};

try {
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    project = parseProject(saved);
    message("Черновик восстановлен из этого браузера");
  }
} catch {
  message("Черновик не удалось прочитать. Можно открыть скачанную схему JSON.");
}

function persist() {
  try {
    localStorage.setItem(storageKey, serializeProject(project));
    message("Черновик сохранён в этом браузере");
  } catch {
    message("Черновик не поместился в браузере — скачай всю схему JSON.");
  }
}
function snapshot() {
  const history = histories.get(sheetId);
  history.push(JSON.stringify(current()));
  if (history.length > 80) history.shift();
}
function paintMark(ctx, mark) {
  ctx.strokeStyle = ctx.fillStyle = mark.color;
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (mark.type === "pen") {
    const [first, ...rest] = mark.points;
    ctx.moveTo(first.x, first.y);
    for (const p of rest) ctx.lineTo(p.x, p.y);
    if (!rest.length) {
      ctx.arc(first.x, first.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    } else ctx.stroke();
  } else if (mark.type === "rect") {
    ctx.strokeRect(
      mark.from.x,
      mark.from.y,
      mark.to.x - mark.from.x,
      mark.to.y - mark.from.y,
    );
  } else if (mark.type === "arrow") {
    const { from, to } = mark;
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(
      to.x - 24 * Math.cos(angle - Math.PI / 6),
      to.y - 24 * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      to.x - 24 * Math.cos(angle + Math.PI / 6),
      to.y - 24 * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.font = "600 28px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textBaseline = "top";
    const width = Math.min(WIDTH, ctx.measureText(mark.text).width + 18);
    const x = Math.max(0, Math.min(mark.at.x, WIDTH - width));
    const y = Math.max(0, Math.min(mark.at.y, HEIGHT - 42));
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.fillRect(x - 4, y - 3, width, 40);
    ctx.fillStyle = mark.color;
    ctx.fillText(mark.text, x + 3, y + 2, WIDTH - x - 5);
  }
}
function imageFor(background) {
  if (background === "grid") return null;
  const source = imageSources[background] || background;
  if (!imageCache.has(source)) {
    const image = new Image();
    const record = { image, ready: false, failed: false };
    imageCache.set(source, record);
    image.onload = () => {
      record.ready = true;
      render();
    };
    image.onerror = () => {
      record.failed = true;
      render();
      message("Подложка недоступна. Выбери сетку или своё фото.");
    };
    image.src = source;
  }
  return imageCache.get(source);
}
function paintSheet(ctx, sheet, preview) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const background = imageFor(sheet.background);
  if (background?.ready) {
    const image = background.image;
    const scale = Math.min(
      WIDTH / image.naturalWidth,
      HEIGHT / image.naturalHeight,
    );
    ctx.drawImage(
      image,
      (WIDTH - image.naturalWidth * scale) / 2,
      (HEIGHT - image.naturalHeight * scale) / 2,
      image.naturalWidth * scale,
      image.naturalHeight * scale,
    );
  } else {
    ctx.strokeStyle = "#e0e7ee";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= WIDTH; x += 40) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, HEIGHT);
    }
    for (let y = 0; y <= HEIGHT; y += 40) {
      ctx.moveTo(0, y);
      ctx.lineTo(WIDTH, y);
    }
    ctx.stroke();
  }
  for (const mark of sheet.marks) paintMark(ctx, mark);
  if (preview) paintMark(ctx, preview);
}
function render() {
  paintSheet(context, current(), pending);
  $("undo").disabled = !histories.get(sheetId).length;
}
function syncSheet() {
  const sheet = current();
  $("sheet-title").textContent = SHEETS.find(({ id }) => id === sheetId).title;
  $("note").value = sheet.note;
  $("background").value = ["grid", "hall", "main"].includes(sheet.background)
    ? sheet.background
    : "custom";
  render();
}
function position(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(WIDTH, ((event.clientX - rect.left) / rect.width) * WIDTH),
    ),
    y: Math.max(
      0,
      Math.min(HEIGHT, ((event.clientY - rect.top) / rect.height) * HEIGHT),
    ),
  };
}
function cancelDrawing() {
  pending = null;
  pointerId = null;
  render();
}
canvas.addEventListener("pointerdown", (event) => {
  if (pointerId !== null || event.button !== 0) return;
  event.preventDefault();
  const at = position(event);
  if (tool === "text") {
    const text = $("text").value.trim();
    if (!text) {
      message("Сначала напиши текст подписи слева.");
      $("text").focus();
      return;
    }
    snapshot();
    current().marks.push({ type: "text", color, at, text });
    persist();
    render();
    return;
  }
  pointerId = event.pointerId;
  canvas.setPointerCapture(pointerId);
  pending =
    tool === "pen"
      ? { type: "pen", color, points: [at] }
      : { type: tool, color, from: at, to: at };
  render();
});
canvas.addEventListener("pointermove", (event) => {
  if (event.pointerId !== pointerId || !pending) return;
  const p = position(event);
  if (pending.type === "pen") {
    const previous = pending.points.at(-1);
    if (Math.hypot(previous.x - p.x, previous.y - p.y) > 1.5)
      pending.points.push(p);
  } else pending.to = p;
  render();
});
canvas.addEventListener("pointerup", (event) => {
  if (event.pointerId !== pointerId || !pending) return;
  const mark = pending;
  if (mark.type !== "pen") mark.to = position(event);
  snapshot();
  current().marks.push(mark);
  pending = null;
  pointerId = null;
  persist();
  render();
});
canvas.addEventListener("pointercancel", cancelDrawing);
canvas.addEventListener("lostpointercapture", () => {
  if (pending) cancelDrawing();
});
$("sheet").addEventListener("change", () => {
  cancelDrawing();
  sheetId = $("sheet").value;
  syncSheet();
});
for (const button of document.querySelectorAll("[data-tool]"))
  button.addEventListener("click", () => {
    tool = button.dataset.tool;
    for (const item of document.querySelectorAll("[data-tool]"))
      item.setAttribute("aria-pressed", String(item === button));
  });
for (const button of document.querySelectorAll("[data-color]"))
  button.addEventListener("click", () => {
    color = button.dataset.color;
    for (const item of document.querySelectorAll("[data-color]"))
      item.setAttribute("aria-pressed", String(item === button));
  });
$("undo").addEventListener("click", () => {
  const entry = histories.get(sheetId).pop();
  if (!entry) return;
  project.sheets[project.sheets.findIndex(({ id }) => id === sheetId)] =
    JSON.parse(entry);
  persist();
  syncSheet();
});
$("clear").addEventListener("click", () => {
  if (!current().marks.length && !current().note) return;
  if (
    !confirm(
      "Очистить рисунок и пояснение только на этом листе? Другие листы сохранятся. Действие можно отменить кнопкой «Отменить».",
    )
  )
    return;
  snapshot();
  current().marks = [];
  current().note = "";
  persist();
  syncSheet();
});
$("note").addEventListener("input", () => {
  current().note = $("note").value;
  persist();
});
$("zoom").addEventListener("input", () => {
  const zoom = $("zoom").value;
  canvas.style.width = `${zoom}%`;
  $("zoom-label").textContent = `${zoom}%`;
});
$("background").addEventListener("change", () => {
  if ($("background").value === "custom") {
    $("image-file").click();
    return;
  }
  snapshot();
  current().background = $("background").value;
  persist();
  render();
});
$("load-background").addEventListener("click", () => $("image-file").click());
$("image-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) {
    syncSheet();
    return;
  }
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 12 * 1024 * 1024
  ) {
    message("Выбери PNG, JPEG или WebP размером до 12 МБ.");
    syncSheet();
    return;
  }
  const selectedId = sheetId;
  try {
    const bitmap = await createImageBitmap(file);
    const temp = document.createElement("canvas");
    const ratio = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    temp.width = Math.round(bitmap.width * ratio);
    temp.height = Math.round(bitmap.height * ratio);
    temp.getContext("2d").drawImage(bitmap, 0, 0, temp.width, temp.height);
    bitmap.close();
    if (sheetId !== selectedId) {
      message("Лист сменился: выбери фото ещё раз для нужного листа.");
      return;
    }
    snapshot();
    current().background = temp.toDataURL("image/jpeg", 0.87);
    persist();
    syncSheet();
  } catch {
    message("Не получилось открыть изображение. Попробуй другое фото.");
    syncSheet();
  }
});

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("save-project").addEventListener("click", () => {
  download(
    new Blob([serializeProject(project)], { type: "application/json" }),
    "МИРЭА-лестница-схема.json",
  );
  message("Схема JSON подготовлена. Сохрани файл и прикрепи его в чат.");
});
$("save-png").addEventListener("click", async () => {
  const sheet = current();
  const background = imageFor(sheet.background);
  if (background && !background.ready) {
    message("Подложка ещё не загрузилась. Дождись снимка или выбери сетку.");
    return;
  }
  const output = document.createElement("canvas");
  output.width = WIDTH;
  output.height = HEIGHT + 170;
  const ctx = output.getContext("2d");
  paintSheet(ctx, sheet);
  ctx.fillStyle = "#eef2f5";
  ctx.fillRect(0, HEIGHT, WIDTH, 170);
  ctx.fillStyle = "#172d43";
  ctx.font = "600 24px sans-serif";
  ctx.fillText(
    `МИРЭА В78 · ${SHEETS.find(({ id }) => id === sheetId).title} · поясняющая схема`,
    24,
    HEIGHT + 36,
  );
  ctx.font = "20px sans-serif";
  const words = (
    sheet.note ||
    "Нижние спуски уточняются. Схема не задаёт размеры и номер этажа выхода к ИВЦ."
  ).split(/\s+/);
  let line = "",
    y = HEIGHT + 70;
  for (const word of words) {
    const test = `${line}${word} `;
    if (ctx.measureText(test).width > WIDTH - 48) {
      ctx.fillText(line, 24, y);
      line = `${word} `;
      y += 27;
    } else line = test;
    if (y > HEIGHT + 140) break;
  }
  if (y <= HEIGHT + 140) ctx.fillText(line, 24, y);
  output.toBlob((blob) => {
    if (blob) download(blob, `МИРЭА-лестница-${sheetId}.png`);
  }, "image/png");
});
$("open-project").addEventListener("click", () => $("project-file").click());
$("project-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 24 * 1024 * 1024) {
    message("Файл схемы слишком большой: максимум 24 МБ.");
    return;
  }
  try {
    const loaded = parseProject(await file.text());
    if (
      project.sheets.some((sheet) => sheet.marks.length || sheet.note) &&
      !confirm(
        "Заменить текущий черновик схемой из файла? Сначала скачай свой черновик, если хочешь сохранить обе версии.",
      )
    )
      return;
    cancelDrawing();
    project = loaded;
    for (const history of histories.values()) history.length = 0;
    persist();
    syncSheet();
    message("Все три листа открыты из JSON и сохранены в черновик.");
  } catch (error) {
    message(`Не удалось открыть схему: ${error.message}`);
  }
});
document.addEventListener("keydown", (event) => {
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "z" &&
    !["INPUT", "TEXTAREA"].includes(event.target.tagName)
  ) {
    event.preventDefault();
    $("undo").click();
  }
  if (event.key === "Escape") cancelDrawing();
});
syncSheet();
