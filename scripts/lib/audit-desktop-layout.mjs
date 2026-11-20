import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Start on the loaded map. Width and height are the effective CSS viewport
// after browser zoom. Mobile and compact landscape have their own controls.
export async function checkDesktopLayout(page, { width, height }) {
  if (width <= 700 || (width <= 1100 && height <= 520)) return;
  const search = page.locator("#desktop-search");
  assert.ok(await search.isVisible(), `Desktop search on ${width}×${height}`);
  const tap = await page.evaluate(
    () => matchMedia("(pointer: coarse)").matches,
  );
  const activate = async (locator) => {
    if (tap) await locator.tap();
    else await locator.click();
  };
  const bounds = await page.evaluate(() => {
    const panel = document.querySelector(".sidebar").getBoundingClientRect();
    const help = document
      .querySelector("#desktop-help-open")
      .getBoundingClientRect();
    return {
      viewportWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      panelLeft: panel.left,
      panelRight: panel.right,
      helpLeft: help.left,
      helpBottom: help.bottom,
    };
  });
  assert.ok(Math.abs(bounds.viewportWidth - width) <= 1);
  assert.ok(bounds.scrollWidth <= width + 1);
  assert.ok(bounds.panelLeft >= 0 && bounds.panelRight < bounds.helpLeft);
  assert.ok(bounds.helpBottom <= height + 1);

  await activate(page.locator("#desktop-collapse"));
  assert.equal(await search.getAttribute("aria-expanded"), "false");
  assert.equal(
    await page.locator("#sheet-content").evaluate((el) => el.inert),
    true,
  );
  await activate(search);
  assert.equal(await search.getAttribute("aria-expanded"), "true");
  assert.equal(
    await page
      .locator("#search")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.locator("#search").fill("Г-209");
  await activate(page.locator("#results button").first());
  await page.locator("#room-card").waitFor({ state: "visible" });
  assert.match(await page.locator("#room-card h2").innerText(), /Г-209/);
  await activate(page.locator(".card-close"));

  await activate(page.locator("#desktop-help-open"));
  assert.equal(
    await page
      .locator("#desktop-help-dialog")
      .evaluate((dialog) => dialog.open),
    true,
  );
  await activate(page.locator("#desktop-help-close"));
  const mode = page.locator("#mode-toggle");
  const projection = await mode.getAttribute("aria-pressed");
  await activate(mode);
  assert.notEqual(await mode.getAttribute("aria-pressed"), projection);
  await activate(mode);
  assert.equal(await mode.getAttribute("aria-pressed"), projection);
}

// Native tab zoom exercises fractional layout viewports. Setting DPR or
// pinch-zoom alone does not make the CSS media queries cross these boundaries.
export async function checkChromiumZoomBreakpoints(
  chromium,
  url,
  executablePath,
) {
  const extension = await mkdtemp(path.join(tmpdir(), "atlas-browser-zoom-"));
  let context;
  try {
    await writeFile(
      path.join(extension, "manifest.json"),
      JSON.stringify({
        name: "Local atlas zoom test",
        version: "1.0",
        manifest_version: 3,
        permissions: ["tabs"],
        background: { service_worker: "zoom.js" },
      }),
    );
    await writeFile(
      path.join(extension, "zoom.js"),
      "chrome.runtime.onInstalled.addListener(() => {});\n",
    );
    context = await chromium.launchPersistentContext("", {
      executablePath,
      channel: "chromium",
      headless: true,
      viewport: null,
      args: [
        "--enable-unsafe-swiftshader",
        "--disable-extensions-except=" + extension,
        "--load-extension=" + extension,
      ],
    });
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const page = context.pages()[0] || (await context.newPage());
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.__atlas));
    const chromeSize = await page.evaluate(() => [
      outerWidth - innerWidth,
      outerHeight - innerHeight,
    ]);
    for (const [factor, sizes] of [
      [
        1.25,
        [
          [875, 830],
          [876, 830],
          [1100, 650],
          [1100, 651],
          [1375, 500],
          [1376, 500],
        ],
      ],
      [
        2,
        [
          [1400, 1200],
          [1401, 1200],
          [1500, 1040],
          [1500, 1041],
        ],
      ],
    ]) {
      await worker.evaluate(
        async ({ url, factor }) => {
          const tab = (await chrome.tabs.query({})).find((t) =>
            t.url.startsWith(url),
          );
          await chrome.tabs.setZoom(tab.id, factor);
        },
        { url, factor },
      );
      for (const [width, height] of sizes) {
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: {
            width: width + chromeSize[0],
            height: height + chromeSize[1],
          },
        });
        await page.waitForFunction(
          ([w, h]) =>
            Math.abs(visualViewport.width - w) < 0.02 &&
            Math.abs(visualViewport.height - h) < 0.02,
          [width / factor, height / factor],
        );
        const desktop =
          width / factor > 700 &&
          (width / factor > 1100 || height / factor > 520);
        const search = page.locator(
          desktop ? "#desktop-search" : "#sheet-toggle",
        );
        const message = `${width}×${height} at ${factor * 100}%`;
        assert.equal(await search.isVisible(), true, message);
        await search.click();
        await page.locator("#search").fill("Г-209");
        await page.locator("#results button").first().click();
        assert.match(
          await page.locator("#room-card h2").innerText(),
          /Г-209/,
          message,
        );
        await page.locator(".card-close").click();
      }
    }
  } finally {
    try {
      await context?.close();
    } finally {
      await rm(extension, { recursive: true, force: true });
    }
  }
}
