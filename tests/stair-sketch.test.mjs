import test from "node:test";
import assert from "node:assert/strict";
import {
  createProject,
  parseProject,
  serializeProject,
} from "../tools/stair-sketch-model.mjs";

test("stair sketch export/import retains all sheets, drawings, labels and local background", () => {
  const project = createProject();
  project.sheets[0].marks = [
    {
      type: "pen",
      color: "#c64532",
      points: [
        { x: 20, y: 30 },
        { x: 80, y: 100 },
      ],
    },
    {
      type: "arrow",
      color: "#167052",
      from: { x: 50, y: 60 },
      to: { x: 70, y: 90 },
    },
    {
      type: "rect",
      color: "#152d48",
      from: { x: 150, y: 160 },
      to: { x: 270, y: 290 },
    },
    {
      type: "text",
      color: "#152d48",
      at: { x: 100, y: 200 },
      text: "Дверь к библиотеке",
    },
  ];
  project.sheets[1].note = "Два марша, затем площадка. Высота не установлена.";
  project.sheets[2].background = "data:image/png;base64,aGVsbG8=";
  assert.deepEqual(parseProject(serializeProject(project)), project);
});

test("stair sketch rejects foreign formats, external backgrounds, duplicate sheets and invalid coordinates", () => {
  assert.throws(() => parseProject('{"format":"other"}'), /не файл/);
  const project = createProject();
  project.sheets[0].background = "https://example.org/pixel.png";
  assert.throws(() => parseProject(serializeProject(project)), /Подложка/);
  project.sheets[0].background = "grid";
  project.sheets[0].marks.push({
    type: "arrow",
    from: { x: "invalid", y: 10 },
    to: { x: 20, y: 30 },
  });
  assert.throws(() => parseProject(serializeProject(project)), /координаты/);
  project.sheets[0].marks = [];
  project.sheets[1].id = "entrance";
  assert.throws(() => parseProject(serializeProject(project)), /листов/);
});
