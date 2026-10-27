import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  findPlaces,
  PLACE_CATEGORIES,
  categoryForPlaceQuery,
  placeCategory,
} from "../src/data/place-search.js";
import {
  rankNearbyPlaces,
  nearbyDistanceLabel,
} from "../src/data/nearby-places.js";
import {
  placeLocation,
  presentPlaceIdentity,
} from "../src/data/place-location.js";

function harness() {
  class Element {
    children = [];
    hidden = false;
    value = "";
    attributes = {};
    listeners = {};
    innerHTML = "";
    textContent = "";
    tagName = "DIV";
    replaceChildren(...children) {
      this.children = children;
      this.innerHTML = "";
    }
    append(...children) {
      this.children.push(...children);
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    }
    focus() {}
    blur() {}
    click() {
      this.onclick?.();
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(selector === "button" && child.tagName === "BUTTON" ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
  }
  const elements = new Map();
  const $ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const messages = [];
  let worker;
  class Worker {
    constructor() {
      worker = this;
    }
    postMessage(message) {
      messages.push(message);
    }
    terminate() {}
  }
  const floor = { id: "f1", level: 0, buildingLevels: { А: 1 } };
  const state = {
    floor,
    loading: 1,
    manifest: { campuses: [{ id: "v-78", floors: [floor] }] },
    search: [
      {
        id: "food-1",
        campusId: "v-78",
        floorId: "f1",
        building: "А",
        label: "Буфет",
        kind: "cafeteria",
        center: [5, 0],
      },
      {
        id: "food-2",
        campusId: "v-78",
        floorId: "f1",
        building: "А",
        label: "Столовая",
        kind: "cafeteria",
        center: [10, 0],
      },
      {
        id: "room",
        campusId: "v-78",
        floorId: "f1",
        building: "А",
        label: "А-101",
        kind: "room",
        center: [0, 0],
      },
    ],
  };
  let located = 0;
  const chosen = [];
  const sandbox = {
    $,
    icon: () => "",
    escape: String,
    findPlaces,
    PLACE_CATEGORIES,
    categoryForPlaceQuery,
    placeCategory,
    rankNearbyPlaces,
    nearbyDistanceLabel,
    placeLocation,
    presentPlaceIdentity,
    placeLandmarks: { hints: {} },
    URL,
    Worker,
    setTimeout,
    clearTimeout,
    document: {
      activeElement: null,
      createElement(tag) {
        const result = new Element();
        result.tagName = tag.toUpperCase();
        return result;
      },
    },
  };
  const source = readFileSync(
    new URL("../src/ui/search.js", import.meta.url),
    "utf8",
  )
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/export /g, "")
    .replace(/import\.meta\.url/g, '"https://local.test/search.js"');
  const { bindSearch } = vm.runInNewContext(
    `${source}\n;({bindSearch})`,
    sandbox,
  );
  const api = bindSearch({
    state,
    navigateRoom: (room) => chosen.push(room.id),
    onLocate: () => located++,
  });
  return {
    state,
    $,
    api,
    messages,
    chosen,
    get located() {
      return located;
    },
    reply(id, result) {
      worker.onmessage({ data: { id, result } });
    },
    fail(id) {
      worker.onmessage({ data: { id, error: true } });
    },
  };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

test("category dropdown shows several places immediately and keeps a working location action", async () => {
  const h = harness();
  h.$("#search").value = "еда";
  await h.api.refresh();
  const results = h.$("#results");
  assert.equal(
    results.children.filter((c) => c.className === "place-result").length,
    2,
  );
  results
    .querySelectorAll("button")
    .find((b) => b.className === "nearby-locate")
    .click();
  assert.equal(h.located, 1);
  assert.equal(
    results
      .querySelectorAll("button")
      .some((b) => b.className === "nearby-more"),
    false,
  );
  results.children.find((c) => c.className === "place-result").click();
  assert.equal(h.chosen.length, 1);
});

test("an old nearest result cannot replace a newer numbered-room search", async () => {
  const h = harness();
  h.state.userLocation = {
    source: "manual",
    campusId: "v-78",
    floorId: "f1",
    building: "А",
    placeId: "room",
    point: [0, 0],
  };
  h.$("#search").value = "еда";
  const first = h.api.refresh();
  assert.equal(h.messages.length, 1);
  h.$("#search").value = "А-101";
  await h.api.refresh();
  assert.match(h.$("#results").children[0].innerHTML, /А-101/u);
  h.reply(h.messages[0].id, {
    mode: "routes",
    items: [{ room: h.state.search[0], reachable: true }],
    nearest: { room: h.state.search[0] },
  });
  await first;
  assert.match(h.$("#results").children[0].innerHTML, /А-101/u);
});

test("changing location refreshes an ordered dropdown with distances and building labels", async () => {
  const h = harness();
  h.$("#search").value = "буфет";
  await h.api.refresh();
  h.state.userLocation = {
    source: "manual",
    campusId: "v-78",
    floorId: "f1",
    building: "А",
    point: [11, 0],
  };
  await h.api.refresh();
  const results = h.$("#results");
  assert.match(results.children[0].innerHTML, /по прямой/u);
  const places = results.children.filter(
    (child) => child.className === "place-result",
  );
  assert.equal(places.length, 2);
  assert.match(places[0].innerHTML, /Столовая/u);
  places[0].click();
  assert.deepEqual(h.chosen, ["food-2"]);
});

test("navigation while the worker runs prevents the old category result reopening", async () => {
  const h = harness();
  h.state.userLocation = {
    source: "manual",
    campusId: "v-78",
    floorId: "f1",
    building: "А",
    placeId: "room",
    point: [0, 0],
  };
  h.$("#search").value = "еда";
  const request = h.api.refresh();
  h.state.loading++;
  h.$("#results").replaceChildren();
  h.$("#results").hidden = true;
  h.reply(h.messages[0].id, {
    mode: "routes",
    items: [{ room: h.state.search[0] }],
    nearest: { room: h.state.search[0] },
  });
  await request;
  await turn();
  assert.equal(h.$("#results").hidden, true);
  assert.equal(h.$("#results").children.length, 0);
});

test("explicit closing prevents a pending result from reopening the search panel", async () => {
  const h = harness();
  h.state.userLocation = {
    source: "manual",
    campusId: "v-78",
    floorId: "f1",
    building: "А",
    placeId: "room",
    point: [0, 0],
  };
  h.$("#search").value = "еда";
  const request = h.api.refresh();
  h.api.close();
  h.reply(h.messages[0].id, {
    mode: "routes",
    items: [{ room: h.state.search[0] }],
    nearest: { room: h.state.search[0] },
  });
  await request;
  assert.equal(h.$("#results").hidden, true);
  assert.equal(h.$("#search").attributes["aria-expanded"], "false");
  assert.equal(h.$("#search-status").textContent, "");
});

test("a route lookup error falls back to labelled straight-line results, and failed GPS keeps location selection available", async () => {
  const h = harness();
  h.state.userLocation = {
    source: "manual",
    campusId: "v-78",
    floorId: "f1",
    building: "А",
    point: [11, 0],
    placeId: "room",
  };
  h.$("#search").value = "буфет рядом";
  const request = h.api.refresh();
  h.fail(h.messages[0].id);
  await request;
  assert.match(h.$("#results").children[0].innerHTML, /по прямой/u);
  assert.doesNotMatch(
    h.$("#results").children[0].innerHTML,
    /Ближайшее по маршруту/u,
  );
  h.state.userLocation = {
    source: "gps",
    status: "error",
    floorId: null,
    point: null,
  };
  h.$("#search").value = "еда";
  await h.api.refresh();
  const results = h.$("#results");
  assert.match(results.children[0].innerHTML, /Укажите, где вы/u);
  const locate = results
    .querySelectorAll("button")
    .find((button) => button.className === "nearby-locate");
  assert.ok(locate);
  locate.click();
  assert.equal(h.located, 1);
  results
    .querySelectorAll("button")
    .find((button) => button.className === "place-result")
    .click();
  assert.equal(h.chosen.length, 1);
});

test("a long nearest dropdown initially shows five sorted places and expands explicitly", async () => {
  const h = harness();
  const row = h.state.search[0];
  for (let i = 3; i <= 7; i++)
    h.state.search.push({ ...row, id: `food-${i}`, center: [i * 10, 0] });
  h.state.userLocation = {
    source: "manual",
    campusId: "v-78",
    floorId: "f1",
    building: "А",
    point: [0, 0],
  };
  h.$("#search").value = "буфет";
  await h.api.refresh();
  const places = () =>
    h.$("#results").children.filter((c) => c.className === "place-result");
  assert.equal(places().length, 5);
  assert.match(places()[0].innerHTML, /Буфет.*Корпус А.*5 м по прямой/su);
  h.$("#results")
    .querySelectorAll("button")
    .find((b) => b.className === "nearby-more")
    .click();
  assert.equal(places().length, 7);
});

test("live GPS compares the explicitly chosen map floor without claiming a measured floor", async () => {
  const h = harness();
  const now = Date.now();
  h.state.userLocation = {
    source: "gps",
    campusId: "v-78",
    floorId: "f1",
    building: "А",
    physicalLevel: 1,
    floorEvidence: "manual-view-selection",
    point: [11, 0],
    timestamp: now,
    expiresAt: now + 60000,
    trackingStatus: "live",
  };
  h.$("#search").value = "буфет";
  await h.api.refresh();
  assert.match(h.$("#results").children[0].innerHTML, /выбранном этаже/);
  assert.match(
    h.$("#results").children.find((c) => c.className === "place-result")
      .innerHTML,
    /Столовая.*1 м по прямой/su,
  );
  assert.equal(h.messages.length, 0, "GPS never borrows a graph room");
  h.api.close();
  await h.api.refreshPosition();
  assert.equal(h.$("#results").hidden, true);
});
