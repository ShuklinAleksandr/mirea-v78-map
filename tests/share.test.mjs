import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { nativeShareLink } from "../src/mobile.js";

// Exercise the production sharing controller at the native/browser API boundary.
// Showing and dismissing the OS share sheet still requires native UI checks.
function sharing({ platform = "web", webShare = true, failure } = {}) {
  const calls = [],
    messages = [];
  const capture = (type) => async (payload) => {
    calls.push({ type, payload: JSON.parse(JSON.stringify(payload)) });
    if (failure) throw failure;
  };
  const sandbox = {
    Capacitor: { isNativePlatform: () => platform !== "web" },
    Share: { share: capture("native") },
    nativeShareLink,
    navigator: {
      ...(webShare ? { share: capture("web") } : {}),
      clipboard: { writeText: capture("clipboard") },
    },
    location: { origin: "https://map.example", pathname: "/v78/" },
  };
  const source = readFileSync(
    new URL("../src/ui/experience.js", import.meta.url),
    "utf8",
  )
    .replace(/^import .*;\n/gm, "")
    .replace(/export /g, "");
  const { shareView } = vm.runInNewContext(
    `${source}\n;({shareView})`,
    sandbox,
  );
  return {
    calls,
    messages,
    share: (hash) => shareView(hash, (message) => messages.push(message)),
  };
}

test("native sharing uses the plugin and keeps custom links in text on iOS and Android", async () => {
  for (const platform of ["ios", "android"]) {
    const h = sharing({ platform });
    await h.share("#campus=v-78&room=Г-209&from=Г-103-1&to=Г-209");
    assert.deepEqual(h.calls, [
      {
        type: "native",
        payload: {
          title: "МИРЭА · Вернадского, 78",
          text: "mireamap://map#campus=v-78&room=Г-209&from=Г-103-1&to=Г-209",
          dialogTitle: "Поделиться картой",
        },
      },
    ]);
    assert.deepEqual(h.messages, []);
  }
});

test("web sharing keeps the browser URL and falls back to clipboard when Web Share is absent", async () => {
  const web = sharing();
  await web.share("#campus=v-78&room=Г-209");
  assert.deepEqual(web.calls, [
    {
      type: "web",
      payload: {
        title: "МИРЭА · Вернадского, 78",
        url: "https://map.example/v78/#campus=v-78&room=Г-209",
      },
    },
  ]);
  const clipboard = sharing({ webShare: false });
  await clipboard.share("#campus=v-78");
  assert.deepEqual(clipboard.calls, [
    { type: "clipboard", payload: "https://map.example/v78/#campus=v-78" },
  ]);
  assert.deepEqual(clipboard.messages, ["Ссылка скопирована"]);
});

test("canceling either native share sheet or Web Share is silent", async () => {
  for (const platform of ["ios", "android", "web"]) {
    const failure =
      platform === "web"
        ? Object.assign(new Error("Canceled"), { name: "AbortError" })
        : new Error("Share canceled");
    const h = sharing({ platform, failure });
    await h.share("#campus=v-78");
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.messages, []);
  }
});

test("actual native/browser/clipboard failures give retry feedback without a false success", async () => {
  for (const options of [
    { platform: "ios" },
    { platform: "android" },
    { platform: "web" },
    { platform: "web", webShare: false },
  ]) {
    const h = sharing({ ...options, failure: new Error("Unavailable") });
    await h.share("#campus=v-78");
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.messages, [
      "Не удалось отправить ссылку. Попробуйте ещё раз.",
    ]);
  }
});
