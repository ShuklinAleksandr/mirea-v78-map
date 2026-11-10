import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { isCompactLandscape } from "../src/ui/map-viewport.js";

test("desktop shortcuts open search and control the map without stealing text editing or dialog keys", () => {
  const actions = [];
  let editing = false;
  const help = Object.assign(new EventTarget(), {
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  });
  const elements = new Map([["#desktop-help-dialog", help]]);
  const $ = (selector) => {
    if (selector === "dialog[open]") return help.open ? help : null;
    if (!elements.has(selector))
      elements.set(selector, { click: () => actions.push(selector) });
    return elements.get(selector);
  };
  const document = Object.assign(new EventTarget(), {
    body: { dataset: {} },
    activeElement: { matches: () => editing },
  });
  const context = {
    $,
    document,
    isCompactLandscape,
    innerWidth: 1280,
    innerHeight: 720,
  };
  const source = readFileSync(
    new URL("../src/ui/desktop.js", import.meta.url),
    "utf8",
  )
    .replace(/^import .*;$/gm, "")
    .replace("export function", "function");
  vm.runInNewContext(source + "\nthis.bind = bindDesktopNavigation;", context);
  context.bind({
    experience: { openSearch: () => actions.push("search") },
    dismissRoom: () => actions.push("dismiss"),
  });
  const press = (key, data = {}) => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), {
      key,
      ...data,
    });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(press("k", { ctrlKey: true, code: "KeyK" }), true);
  editing = true;
  press("+");
  press("0");
  press("/");
  press("Escape");
  assert.deepEqual(actions, ["search"]);
  press("л", { metaKey: true, code: "KeyK" });
  assert.deepEqual(actions, ["search", "search"]);
  editing = false;
  press("+");
  press("-");
  press("0");
  assert.deepEqual(actions.slice(-3), ["#zoom-in", "#zoom-out", "#fit"]);
  $("#desktop-help-open").onclick();
  const count = actions.length;
  press("/");
  press("Escape");
  assert.equal(actions.length, count);
  $("#desktop-help-close").onclick();
  press("Escape");
  assert.equal(actions.at(-1), "dismiss");
  context.innerWidth = 390;
  press("+");
  assert.equal(actions.at(-1), "dismiss");
});
