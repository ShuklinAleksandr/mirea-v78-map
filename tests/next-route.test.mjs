import test from "node:test";
import assert from "node:assert/strict";
import { nextRouteReadout } from "../src/ui/next-route.js";
import { createRouteTracker } from "../src/data/route-tracking.js";

const route = {
  durationMinutes: 2,
  distanceMeters: 90,
  steps: [
    { kind: "turn", text: "Поверните направо", floorId: "first" },
    { kind: "stairs", text: "Поднимитесь", targetFloorId: "second" },
    { kind: "arrive", text: "У аудитории" },
  ],
};
const view = (options = {}) =>
  nextRouteReadout({
    route,
    to: { label: "Г-209" },
    guiding: true,
    automatic: true,
    following: true,
    liveProgress: { status: "tracking", distanceToNextMeters: 17.7 },
    ...options,
  });

test("Next leaves only the upcoming action while fresh GPS is tracking", () => {
  const current = view();
  assert.equal(current.showNext, false);
  assert.equal(current.showRecenter, false);
  assert.equal(current.contextAction, null);
  assert.equal(current.direction, "right");
  assert.equal(current.distance, "≈ 18 м");
  assert.equal(view({ following: false }).showRecenter, true);
});

test("Next never hides the manual fallback or claims distance after GPS uncertainty", () => {
  for (const status of [
    "waiting",
    "acquiring",
    "low-accuracy",
    "stale",
    "off-route",
    "floor-mismatch",
  ]) {
    const current = view({
      liveProgress: { status, distanceToNextMeters: 12 },
    });
    assert.equal(current.showNext, true, status);
    assert.equal(current.distance, "", status);
  }
  assert.equal(
    view({ liveProgress: { status: "low-accuracy" } }).contextAction,
    "refine",
  );
  assert.equal(
    view({ liveProgress: { status: "off-route" } }).contextAction,
    "refine",
  );
  assert.equal(
    view({ liveProgress: { status: "floor-mismatch" } }).contextAction,
    "floor",
  );
  assert.equal(
    view({ liveProgress: { status: "stale" } }).contextAction,
    "locate",
  );
  assert.equal(view({ automatic: false }).contextAction, null);
});

test("Next staircase confirmation names only an established physical floor", () => {
  const known = view({ stepIndex: 1, transitionLevel: 3 });
  assert.equal(known.showNext, true);
  assert.equal(known.nextLabel, "Я на 3 этаже");
  assert.equal(view({ stepIndex: 1 }).nextLabel, "Я на следующем этаже");
  assert.equal(
    view({ stepIndex: 1, transitionLevel: -1 }).nextLabel,
    "Я в цоколе",
  );
  assert.equal(view({ stepIndex: 2 }).nextLabel, "Завершить");
});

test("Next repairs confirmed-location floor errors without trapping the user in the view-only floor picker", () => {
  const points = [
    [0, 0],
    [20, 0],
  ];
  const guidedRoute = {
    campusId: "v-78",
    distanceMeters: 20,
    segments: [
      {
        floorId: "first",
        points,
        nodes: points.map((position) => ({
          position,
          floorId: "first",
          building: "Г",
          physicalLevel: 4,
        })),
      },
    ],
    steps: [
      { kind: "start", floorId: "first", position: points[0] },
      { kind: "arrive", floorId: "first", position: points[1] },
    ],
  };
  const baseLocation = {
    source: "gps",
    campusId: "v-78",
    floorId: "first",
    floorEvidence: "manual",
    building: "Г",
    physicalLevel: 4,
    point: [1, 0],
    timestamp: 1_800_000_000_000,
    accuracyMeters: 3,
  };
  for (const scenario of [
    {
      location: { floorId: "second" },
      visibleFloor: "first",
      reason: "confirm-route-floor",
      action: "refine",
    },
    {
      location: { physicalLevel: 3 },
      visibleFloor: "first",
      reason: "confirm-route-physical-floor",
      action: "refine",
    },
    {
      location: {},
      visibleFloor: "second",
      reason: "confirm-route-floor",
      action: "floor",
    },
  ]) {
    const userLocation = { ...baseLocation, ...scenario.location };
    const liveProgress = createRouteTracker(guidedRoute).update(userLocation, {
      now: userLocation.timestamp,
      floorId: scenario.visibleFloor,
    });
    assert.equal(liveProgress.status, "floor-mismatch");
    assert.equal(liveProgress.reason, scenario.reason);
    const readout = view({ route: guidedRoute, userLocation, liveProgress });
    assert.equal(readout.contextAction, scenario.action);
    assert.equal(
      readout.contextLabel,
      scenario.action === "refine" ? "Уточнить точку" : "Выбрать этаж",
    );
    assert.equal(readout.showNext, true);
    assert.equal(readout.distance, "");
  }
});

test("Next preview does not advertise automatic navigation or a corrective GPS action", () => {
  const preview = view({ automatic: false, previewing: true });
  assert.match(preview.note, /Демонстрация/);
  assert.equal(preview.contextAction, null);
  assert.equal(preview.showNext, true);
  assert.equal(view({ guiding: false }).nextLabel, "В путь");
});

test("a partial route identifies the parent entrance and never turns GPS arrival into arrival in the inner room", () => {
  const partial = {
    ...route,
    partial: true,
    requestedDestination: {
      roomId: "inside",
      label: "Г-424-3",
      floorId: "first",
    },
    end: { roomId: "parent", label: "Г-424" },
    lastLeg: {
      kind: "inside-parent",
      viaRoomId: "parent",
      viaLabel: "Г-424",
      label: "Г-424-3",
      geometryAvailable: false,
      message:
        "Войдите в Г-424 и найдите Г-424-3. Положение внутренней двери пока не нанесено.",
    },
    steps: [
      ...route.steps.slice(0, 2),
      { kind: "manual-entry", text: "Найдите Г-424-3 внутри Г-424" },
    ],
  };
  const preview = view({ route: partial, guiding: false });
  assert.match(preview.meta, /до Г-424$/);
  assert.match(preview.note, /внутри Г-424 пока не нанесён/);
  const progress = view({ route: partial });
  assert.equal(progress.distance, "≈ 18 м");
  assert.equal(
    view({ route: partial, stepIndex: 2 }).distance,
    "≈ 18 м до Г-424",
  );
  for (const status of ["waiting", "tracking", "arrived"]) {
    const current = view({
      route: partial,
      stepIndex: 2,
      liveProgress: { status, arrived: status === "arrived" },
    });
    assert.equal(current.direction, "manual-entry");
    assert.equal(current.nextLabel, "Закрыть маршрут");
    assert.equal(current.showNext, true);
    assert.match(current.note, /Г-424/);
    assert.doesNotMatch(current.note, /пришли|назначения|Г-424-3/);
    assert.equal(current.distance, "");
  }
  const manualOnly = view({
    route: { ...partial, steps: [partial.steps[2]] },
    liveProgress: { status: "floor-mismatch" },
    following: false,
  });
  assert.equal(manualOnly.contextAction, null);
  assert.equal(manualOnly.showRecenter, false);
});
