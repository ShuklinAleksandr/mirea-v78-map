import test from "node:test";
import assert from "node:assert/strict";
import { bindMapTapActions } from "../src/map/pointer-actions.js";

function harness() {
  const window = new EventTarget();
  const surface = Object.assign(new EventTarget(), {
    ownerDocument: { defaultView: window },
    contains: (element) => element === label,
  });
  let selections = 0;
  let mapTaps = 0;
  const label = {
    closest: () => label,
    click: () => selections++,
  };
  const binding = bindMapTapActions(surface, (event, target) => {
    if (target) target.click();
    else mapTaps++;
  });
  surface.addEventListener("click", (event) => {
    if (event.target === label) label.click();
  });
  function emit(
    type,
    { target = surface, id = 1, x = 100, y = 100, detail = 0 } = {},
  ) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerId: id,
      pointerType: "touch",
      clientX: x,
      clientY: y,
      button: 0,
      detail,
    });
    Object.defineProperty(event, "target", { value: target });
    surface.dispatchEvent(event);
  }
  return {
    emit,
    label,
    window,
    binding,
    get selections() {
      return selections;
    },
    get mapTaps() {
      return mapTaps;
    },
  };
}

test("a label tap captured by the map selects exactly once; keyboard activation still works", () => {
  const h = harness();
  h.emit("pointerdown", { target: h.label });
  h.emit("pointerup"); // Pointer capture retargets release to the shared surface.
  h.emit("click", { target: h.label, detail: 1 });
  assert.equal(h.selections, 1);
  assert.equal(h.mapTaps, 0);
  h.emit("click", { target: h.label, detail: 0 });
  assert.equal(h.selections, 2);
  h.binding.dispose();
});

test("a pinch across label and canvas never opens a room in either release order", () => {
  for (const order of [
    [1, 2],
    [2, 1],
  ]) {
    const h = harness();
    h.emit("pointerdown", { target: h.label });
    h.emit("pointerdown", { id: 2, x: 200 });
    h.emit("pointermove", { x: 70 });
    h.emit("pointermove", { id: 2, x: 230 });
    for (const id of order) h.emit("pointerup", { id, x: id === 1 ? 70 : 230 });
    h.emit("click", { target: h.label, detail: 1 });
    assert.equal(h.selections, 0);
    assert.equal(h.mapTaps, 0);
    h.emit("pointerdown", { target: h.label, id: 3 });
    h.emit("pointerup", { id: 3 });
    assert.equal(h.selections, 1, "the next deliberate tap works");
    h.binding.dispose();
  }
});

test("label drag, cancellation, lost capture and window blur never select a place", () => {
  for (const ending of [
    "drag",
    "pointercancel",
    "lostpointercapture",
    "blur",
  ]) {
    const h = harness();
    h.emit("pointerdown", { target: h.label });
    if (ending === "drag") {
      h.emit("pointermove", { x: 150 });
      h.emit("pointermove", { x: 100 });
    } else if (ending === "blur") h.window.dispatchEvent(new Event("blur"));
    else h.emit(ending);
    h.emit("pointerup");
    h.emit("click", { target: h.label, detail: 1 });
    assert.equal(h.selections, 0, ending);
    assert.equal(h.mapTaps, 0, ending);
    h.binding.dispose();
  }
});
