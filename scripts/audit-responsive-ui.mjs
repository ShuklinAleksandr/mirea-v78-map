import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, firefox, webkit } from "playwright-core";
import { build, preview } from "vite";
import {
  checkChromiumZoomBreakpoints,
  checkDesktopLayout,
} from "./lib/audit-desktop-layout.mjs";
import { checkPhoneLayout } from "./lib/audit-phone-layout.mjs";

const engines = { chromium, firefox, webkit };
const selected = process.argv.length > 2 ? process.argv.slice(2) : ["chromium"];
const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const phones = [
  [280, 653],
  [320, 480],
  [320, 568],
  [360, 640],
  [375, 812],
  [512, 300],
  [568, 320],
  [667, 375],
  [740, 360],
];
const largeScreens = [
  [768, 1024],
  [820, 1180],
  [1024, 768],
  [1024, 600],
  [1280, 720],
  [1920, 1080],
  [2560, 1080],
];
const errors = [];

async function checkAccessibility(page, stage) {
  const violations = await page.evaluate(async () => {
    const { violations } = await window.axe.run(document, {
      runOnly: {
        type: "tag",
        values: [
          "wcag2a",
          "wcag2aa",
          "wcag21a",
          "wcag21aa",
          "wcag22aa",
          "best-practice",
        ],
      },
      resultTypes: ["violations"],
    });
    return violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((node) => node.target),
    }));
  });
  assert.deepEqual(violations, [], stage + ": " + JSON.stringify(violations));
}

async function checkChangingWindow(page, url) {
  const button = (id) => page.locator("#" + id);
  const resize = async (width, height) => {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() => {
      const host = document.querySelector("#viewport"),
        canvas = host?.querySelector("canvas");
      return (
        canvas &&
        Math.abs(
          window.__atlas.scene.perspectiveCamera.aspect -
            host.clientWidth / host.clientHeight,
        ) < 1e-4 &&
        Math.abs(canvas.getBoundingClientRect().width - host.clientWidth) < 2 &&
        Math.abs(canvas.getBoundingClientRect().height - host.clientHeight) < 2
      );
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
  };
  await resize(720, 720);
  await checkAccessibility(page, "map");
  await button("desktop-help-open").click();
  await checkAccessibility(page, "map controls help");
  await button("desktop-help-close").click();
  await button("settings-open").click();
  await page.getByRole("dialog", { name: "Настройки" }).waitFor();
  await resize(600, 345);
  await checkAccessibility(page, "settings in landscape");
  await button("theme-setting").selectOption("dark");
  await button("location-options").click();
  await page.getByRole("dialog", { name: "Местоположение" }).waitFor();
  await checkAccessibility(page, "location in dark theme");
  await page.keyboard.press("Escape");
  await resize(520, 520);
  await button("next-floor-open").click();
  await checkAccessibility(page, "floor picker");
  await button("next-floor-rooms").click();
  await checkAccessibility(page, "building rooms");
  await button("building-rooms-close").click();
  await page.keyboard.press("/");
  await button("search").fill("туалеты");
  await page.locator(".nearby-more").waitFor();
  await checkAccessibility(page, "category search");
  await button("search").press("ArrowDown");
  assert.equal(
    await page.evaluate(() => document.activeElement.getAttribute("role")),
    "option",
  );
  await page.keyboard.press("Enter");
  await button("room-card").waitFor({ state: "visible" });
  await resize(390, 844);
  await checkAccessibility(page, "place card");
  const selectedPlace = await page.evaluate(
    () => window.__atlas.state.selected.id,
  );
  await button("room-favorite").focus();
  await page.keyboard.press("Enter");
  assert.match(await button("room-favorite").innerText(), /В избранном/);
  await page.reload();
  await button("room-favorite").waitFor();
  assert.match(await button("room-favorite").innerText(), /В избранном/);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await resize(844, 390);
  assert.equal(
    await page.evaluate(() => window.__atlas.state.selected.id),
    selectedPlace,
  );
  await page.locator(".card-close").focus();
  await page.keyboard.press("Enter");
  const previousView = new URL(page.url()).hash;
  const params = new URLSearchParams({
    campus: "v-78",
    from: "v-78--floor-2--9yb",
    to: "v-78--floor-1--6dn",
  });
  await page.goto(url + "#" + params);
  await page.waitForFunction(
    () => window.__atlas?.routes.getRoute()?.end.label === "Г-209",
  );
  await page.goBack({ waitUntil: "commit" });
  await page.waitForFunction(
    (hash) =>
      location.hash === hash &&
      window.__atlas?.state.floor &&
      !window.__atlas.routes.getRoute(),
    previousView,
  );
  await page.goForward({ waitUntil: "commit" });
  await page.waitForFunction(
    () => window.__atlas?.routes.getRoute()?.end.label === "Г-209",
  );
  await resize(701, 521);
  await checkAccessibility(page, "route across layout breakpoint");
  const before = await button("route-dock-meta").innerText();
  await resize(700, 520);
  assert.equal(await button("route-dock-meta").innerText(), before);
  await button("route-dock-close").click();
  assert.equal(
    await page.evaluate(() => window.__atlas.routes.getRoute()),
    null,
  );
}

async function checkCutouts(browser, url) {
  const cases = [
    [390, 844, { top: 42, bottom: 26 }],
    [844, 390, { left: 42, bottom: 18 }],
    [844, 390, { right: 42, bottom: 18 }],
    [280, 653, { top: 24, bottom: 16 }],
  ];
  for (const [width, height, insets] of cases) {
    const page = await browser.newPage({
      viewport: { width, height },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
    });
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
      await page.goto(
        url + "#campus=v-78&from=v-78--floor-2--9yb&to=v-78--floor-1--6dn",
      );
      await page.waitForFunction(() => window.__atlas?.routes.getRoute()?.ok);
      for (const id of [
        "mode-toggle",
        "settings-open",
        "next-floor-open",
        "fit",
        "locate-open",
        "zoom-in",
        "zoom-out",
        "route-dock-close",
      ]) {
        const button = page.locator("#" + id);
        const box = await button.boundingBox();
        assert.ok(
          box &&
            box.x >= (insets.left || 0) &&
            box.y >= (insets.top || 0) &&
            box.x + box.width <= width - (insets.right || 0) + 1 &&
            box.y + box.height <= height - (insets.bottom || 0) + 1,
          id + " intersects screen cutout",
        );
        await button.tap({ trial: true, timeout: 5000 });
      }
      console.log("PASS chromium", width + "x" + height, "cutout", insets);
    } finally {
      await page.close();
    }
  }
}

async function run(engine, url) {
  const browser = await engines[engine].launch({
    ...(engine === "chromium"
      ? {
          executablePath: process.env.CHROMIUM_EXECUTABLE,
          args: ["--enable-unsafe-swiftshader"],
        }
      : {}),
  });
  try {
    if (engine === "chromium") await checkCutouts(browser, url);
    const cases = [
      {
        name: "resize, keyboard, links and accessibility",
        size: [720, 720],
        check: (page) => checkChangingWindow(page, url),
      },
    ];
    for (const size of engine === "chromium"
      ? phones
      : [
          [320, 480],
          [667, 375],
        ])
      cases.push({ name: "phone", size, check: checkPhoneLayout, touch: true });
    for (const size of engine === "chromium"
      ? largeScreens
      : [
          [768, 1024],
          [1280, 720],
        ])
      cases.push({
        name: "large screen",
        size,
        check: checkDesktopLayout,
        touch: size[0] <= 1024 && engine !== "firefox",
      });
    for (const {
      name,
      size: [width, height],
      check,
      touch = false,
    } of cases) {
      const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: touch,
        ...(name === "phone" && engine !== "firefox" ? { isMobile: true } : {}),
        reducedMotion: "reduce",
      });
      const uncaught = [];
      context.on("page", (p) =>
        p.on("pageerror", (e) => uncaught.push(e.stack || e.message)),
      );
      const page = await context.newPage();
      try {
        page.setDefaultTimeout(12000);
        if (check !== checkPhoneLayout && check !== checkDesktopLayout)
          await page.addInitScript({ path: axePath });
        await page.goto(url);
        await page.waitForFunction(
          () => window.__atlas?.state.floorData.length,
        );
        await check(page, { width, height });
        assert.deepEqual(uncaught, []);
        console.log(
          "PASS",
          engine,
          browser.version(),
          width + "x" + height,
          name,
        );
      } catch (error) {
        errors.push({ engine, width, height, name, error: error.message });
        console.error(
          "FAIL",
          engine,
          width + "x" + height,
          name,
          error.message,
        );
        console.error(
          await page
            .evaluate(() => ({
              viewport: [innerWidth, innerHeight],
              activeElement: document.activeElement?.id,
              sidebar: document.querySelector(".sidebar")?.className,
              dialogs: [...document.querySelectorAll("dialog[open]")].map(
                (dialog) => dialog.id,
              ),
              hash: location.hash,
            }))
            .catch(() => "Page closed"),
        );
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

for (const name of selected)
  assert.ok(Object.hasOwn(engines, name), "Unknown browser " + name);
let server, directory;
try {
  let url = process.env.UI_TEST_URL;
  if (!url) {
    directory = await mkdtemp(path.join(tmpdir(), "mirea-ui-"));
    await build({ base: "/", build: { outDir: directory, emptyOutDir: true } });
    server = await preview({
      base: "/",
      build: { outDir: directory },
      preview: { host: "127.0.0.1", port: 0, open: false },
    });
    url = server.resolvedUrls.local[0];
  }
  for (const name of selected) {
    await run(name, url);
    if (name === "chromium") {
      await checkChromiumZoomBreakpoints(
        chromium,
        url,
        process.env.CHROMIUM_EXECUTABLE,
      );
      console.log("PASS chromium native tab zoom, 10 boundary sizes");
    }
  }
  if (errors.length) process.exitCode = 1;
} finally {
  if (server) await server.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}
