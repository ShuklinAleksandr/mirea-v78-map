import assert from "node:assert/strict";

// A real phone keyboard with adjustResize reduces the CSS viewport. Use the
// same geometry without depending on a particular keyboard being installed.
export async function checkPhoneLayout(page, { width, height }) {
  const field = (id) => page.locator(`#${id}`);
  const tap = (id) => field(id).tap();
  const assertFitsWidth = async (id) => {
    const dimensions = await field(id).evaluate((element) => ({
      content: element.scrollWidth,
      box: element.clientWidth,
    }));
    assert.ok(
      dimensions.content <= dimensions.box + 1,
      `${id} needs ${dimensions.content}px inside ${dimensions.box}px`,
    );
  };
  const setKeyboard = async (open) => {
    const visibleHeight =
      width > height
        ? Math.min(150, height - 160)
        : Math.min(height - 180, 360);
    await page.setViewportSize({
      width,
      height: open ? visibleHeight : height,
    });
    if (open) {
      await page.waitForFunction(
        () =>
          document.querySelector(".sidebar").dataset.keyboardOpen === "true",
      );
    }
  };

  await page.addStyleTag({
    content:
      ":root { -webkit-text-size-adjust: 200% !important; text-size-adjust: 200% !important }",
  });
  await tap("settings-open");
  await assertFitsWidth("settings-dialog");
  await tap("location-options");
  await tap("location-close");

  await tap("sheet-toggle");
  await field("search").fill("Г-209");
  await setKeyboard(true);
  await assertFitsWidth("sheet-toggle");
  await page.locator("#results .place-result").first().tap();
  await setKeyboard(false);
  await field("room-card").waitFor({ state: "visible" });
  assert.equal(await page.locator("#room-card h2").innerText(), "Г-209");
  await assertFitsWidth("sheet-content");
  await tap("room-favorite");
  await page.locator(".card-close").tap();

  await tap("next-floor-open");
  await tap("next-floor-rooms");
  await field("building-rooms-list").waitFor({ state: "visible" });
  await tap("building-rooms-close");

  await tap("route-open");
  for (const [id, query] of [
    ["route-from", "Главный вход"],
    ["route-to", "И-205-а"],
  ]) {
    await field(id).fill(query);
    await setKeyboard(true);
    await page.locator("#route-results [data-id]").first().tap();
    await setKeyboard(false);
  }
  if (width === 568 && height === 320) {
    // Longer than the map controls' six-second idle timeout.
    await page.waitForTimeout(6500);
    assert.notEqual(
      await page.locator("body").getAttribute("data-map-hud-hidden"),
      "true",
    );
  }
  await tap("route-build");
  await page.locator("#route-choice-dialog[open]").waitFor();
  await assertFitsWidth("route-choice-dialog");
  assert.equal(await page.locator(".route-choice").count(), 2);
  await page.locator(".route-choice").last().tap();
  await field("route-guidance-dock").waitFor({ state: "visible" });
  if (width < 520 || width <= height) {
    assert.ok(
      await field("route-dock-next").evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return button.contains(
          document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ),
        );
      }),
      "В путь must be visible before scrolling the route preview",
    );
  }
  // The location tool starts tracking. Only browsers reporting a location
  // error open its dialog. The asynchronous answer can arrive between taps.
  await page.addLocatorHandler(page.locator("#location-dialog[open]"), () =>
    tap("location-close"),
  );
  // All three groups must remain reachable together while the dock is open.
  await tap("settings-open");
  await tap("settings-close");
  await tap("mode-toggle");
  await tap("mode-toggle");
  await tap("locate-open");
  await tap("fit");
  await tap("zoom-in");
  await tap("zoom-out");
  await tap("route-dock-next");
  await assertFitsWidth("route-guidance-dock");
  await tap("route-dock-next");
  await tap("route-dock-previous");
  await tap("route-dock-details");
  await tap("route-fit");
  await tap("route-dock-close");
  assert.equal(
    await page.evaluate(() => window.__atlas.routes.getRoute()),
    null,
  );
}
