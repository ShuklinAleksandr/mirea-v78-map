import assert from "node:assert/strict";

export async function prepareDeniedLocation(page) {
  await page.addInitScript(() => {
    const requests = (window.locationRequests = { gps: 0, compass: 0 });
    Object.defineProperty(navigator, "geolocation", {
      value: {
        watchPosition(_position, error) {
          const id = ++requests.gps;
          setTimeout(() => error({ code: 1 }), 0);
          return id;
        },
        clearWatch() {},
      },
    });
    if (typeof DeviceOrientationEvent !== "undefined")
      Object.defineProperty(DeviceOrientationEvent, "requestPermission", {
        value: async () => {
          requests.compass++;
          return "denied";
        },
      });
  });
}

export async function checkGuidanceFlow(page) {
  const id = (name) => page.locator("#" + name);
  const tap = (name) => id(name).tap();
  const requests = () => page.evaluate(() => window.locationRequests);
  const assertManualGuidance = async () => {
    assert.deepEqual(await requests(), { gps: 1, compass: 0 });
    assert.equal(await id("location-dialog").isVisible(), false);
  };

  await tap("locate-open");
  await id("location-dialog").waitFor();
  await page.waitForFunction(() =>
    /запрещён/i.test(document.querySelector("#location-feedback").textContent),
  );
  assert.deepEqual(await requests(), { gps: 1, compass: 0 });
  await tap("location-close");
  await tap("locate-open");
  await id("location-dialog").waitFor();
  assert.deepEqual(await requests(), { gps: 1, compass: 0 });
  await tap("location-map");
  await id("location-crosshair").waitFor();
  // Frame the entrance under the real crosshair, then use its normal confirm
  // action. This keeps the chosen source area independent of screen geometry.
  await page.evaluate(() => {
    const { state, scene } = window.__atlas;
    const floor = state.floorData.find(({ id }) => id === state.floor.id);
    const [x, z] = floor.polygons.find(
      ({ id }) => id === "v-78--floor-2--9yb",
    ).center;
    scene.fit(
      [x - 8, z - 8, x + 8, z + 8],
      false,
      scene.callbacks.getViewportPadding(),
    );
    scene.updateLocationPickPreview({ force: true });
  });
  await tap("location-pick-confirm");
  assert.deepEqual(
    await page.evaluate(() => {
      const { source, physicalLevel } = window.__atlas.state.userLocation;
      return { source, physicalLevel };
    }),
    { source: "manual", physicalLevel: 2 },
  );
  await tap("locate-open");
  await assertManualGuidance();

  await tap("sheet-toggle");
  await id("search").fill("А-178");
  await page
    .locator("#results .place-result")
    .filter({ hasText: "А-178" })
    .first()
    .tap();
  await tap("room-to");
  await page.waitForFunction(() => window.__atlas.routes.getRoute()?.ok);
  const route = await page.evaluate(() => {
    const { start, end, steps } = window.__atlas.routes.getRoute();
    return { start: start.floorId, end: end.label, steps };
  });
  assert.equal(route.start, "v-78-floor2");
  assert.equal(route.end, "А-178");
  assert.ok(route.steps.some(({ kind }) => kind === "stairs"));

  await tap("route-dock-next");
  await assertManualGuidance();
  const recordedSize = page.viewportSize();
  const firstStep = await id("route-dock-meta").textContent();
  // Model the outer and inner display sizes from the published resolutions.
  // These are window-size tests, including narrower space beside system bars.
  for (const [width, height] of [
    [360, 840], // Galaxy Z Fold7 cover
    [720, 800], // Galaxy Z Fold7 inner
    [800, 720],
    [466, 678], // iPhone Duo cover
    [890, 626], // iPhone Duo inner
    [842, 550],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() => {
      const canvas = document.querySelector("#viewport canvas");
      const rect = canvas.getBoundingClientRect();
      return (
        Math.abs(canvas.parentElement.clientWidth - rect.width) < 2 &&
        Math.abs(canvas.parentElement.clientHeight - rect.height) < 2
      );
    });
    assert.equal(await id("route-dock-meta").textContent(), firstStep);
    for (const button of [
      "route-dock-next",
      "route-dock-details",
      "route-dock-close",
    ]) {
      const control = id(button);
      await control.tap({ trial: true });
      const rect = await control.boundingBox();
      assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1);
      assert.ok(rect.y >= 0 && rect.y + rect.height <= height + 1);
    }
    await assertManualGuidance();
  }
  await page.setViewportSize(recordedSize);
  let maxDockHeight = 0;
  for (const [index, step] of route.steps.entries()) {
    assert.match(
      await id("route-dock-meta").textContent(),
      new RegExp(`шаг ${index + 1} из ${route.steps.length}`, "i"),
    );
    const dock = await id("route-guidance-dock").boundingBox();
    maxDockHeight = Math.max(maxDockHeight, dock.height);
    await tap("route-dock-next");
    await assertManualGuidance();
    if (step.targetFloorId)
      assert.equal(
        await page.evaluate(() => window.__atlas.state.floor.id),
        step.targetFloorId,
      );
  }
  assert.ok(
    maxDockHeight <= recordedSize.height * 0.3,
    `Dock occupied ${maxDockHeight}px`,
  );
  assert.equal(
    await page.evaluate(() => window.__atlas.routes.getRoute()),
    null,
  );

  await tap("settings-open");
  await tap("location-options");
  await id("location-dialog").waitFor();
  await tap("location-gps");
  await page.waitForFunction(() => window.locationRequests.gps === 2);
  assert.deepEqual(await requests(), { gps: 2, compass: 0 });
  console.log(
    `  А-178, ${route.steps.length} steps, dock max ${maxDockHeight}px`,
  );
}
