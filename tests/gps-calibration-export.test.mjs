import test from "node:test";
import assert from "node:assert/strict";
import {
  exportGpsCalibrationJson,
  GPS_CALIBRATION_EXPORT_MAX_BYTES,
} from "../src/data/gps-calibration-export.js";

const json = JSON.stringify(
  { campusId: "v-78", samples: [{ label: "Коридор Г", timestamp: 123 }] },
  null,
  2,
);
const filename = "MIREA-V78-GPS-20261028-120000-123-456.json";

test("native export passes the unchanged JSON to a local file writer, then shares that actual file", async () => {
  for (const uri of [
    "file:///private/var/tmp/gps-calibration/export.json",
    "content://ru.mirea.spatialatlas.fileprovider/cache/export.json",
  ]) {
    const calls = [];
    const result = await exportGpsCalibrationJson(json, {
      native: true,
      plugin: {
        async exportSurvey(value) {
          calls.push(["export", value]);
          return { uri, filename };
        },
      },
      async share(value) {
        calls.push(["share", value]);
      },
    });
    assert.deepEqual(calls[0], ["export", { json }]);
    assert.deepEqual(calls[1][1].files, [uri]);
    assert.equal(calls[1][1].text, undefined, "records are not pasted as text");
    assert.deepEqual(result, { method: "share", filename, uri });
  }
});

test("malformed, wrong-campus and non-object documents never reach native storage or sharing", async () => {
  const calls = [];
  const environment = {
    native: true,
    plugin: { exportSurvey: () => calls.push("write") },
    share: () => calls.push("share"),
  };
  for (const value of [
    null,
    "",
    " ",
    "not json",
    '"v-78"',
    "[]",
    "null",
    '{"campusId":"v-86"}',
    '{"campusId":"v-78"} trailing',
  ])
    await assert.rejects(exportGpsCalibrationJson(value, environment));
  assert.deepEqual(calls, []);
});

test("the export limit counts UTF-8 bytes rather than UTF-16 characters", async () => {
  const oversize = JSON.stringify({
    campusId: "v-78",
    note: "я".repeat(GPS_CALIBRATION_EXPORT_MAX_BYTES / 2),
  });
  assert.ok(oversize.length < GPS_CALIBRATION_EXPORT_MAX_BYTES);
  await assert.rejects(
    exportGpsCalibrationJson(oversize, {
      native: true,
      plugin: { exportSurvey: () => assert.fail("oversized file was written") },
    }),
    /4 МБ/,
  );
});

test("a remote URI or user-controlled path is never handed to the native share sheet", async () => {
  const nativeFiles = [
    { uri: "https://example.test/export.json", filename },
    { uri: "file:///tmp/export.json", filename: "../../export.json" },
    {
      uri: "file:///tmp/export.json",
      filename: "MIREA-V78-GPS-evil/path.json",
    },
    { uri: "file:///tmp/export.json", filename: "MIREA-V78-GPS-good.txt" },
    null,
  ];
  for (const file of nativeFiles)
    await assert.rejects(
      exportGpsCalibrationJson(json, {
        native: true,
        plugin: { exportSurvey: async () => file },
        share: () => assert.fail("invalid native result reached sharing"),
      }),
      /локальный файл/,
    );
});

test("native write and canceled share errors propagate without reporting a successful export", async () => {
  const canceled = new Error("Share canceled");
  await assert.rejects(
    exportGpsCalibrationJson(json, {
      native: true,
      plugin: {
        exportSurvey: async () => ({ uri: "file:///tmp/file.json", filename }),
      },
      share: async () => {
        throw canceled;
      },
    }),
    (error) => error === canceled,
  );
  const writeFailed = new Error("Недостаточно места");
  await assert.rejects(
    exportGpsCalibrationJson(json, {
      native: true,
      plugin: {
        exportSurvey: async () => {
          throw writeFailed;
        },
      },
      share: () => assert.fail("failed file was shared"),
    }),
    (error) => error === writeFailed,
  );
});

test("browser export creates a downloadable UTF-8 JSON Blob and keeps its URL alive through the click", async () => {
  const events = [];
  let blob;
  let cleanup;
  const link = {
    click: () => events.push("click"),
    remove: () => events.push("remove"),
  };
  const result = await exportGpsCalibrationJson(json, {
    native: false,
    plugin: {
      exportSurvey: () => assert.fail("browser called a native plugin"),
    },
    share: () =>
      assert.fail("browser sent records to sharing instead of a file"),
    document: {
      body: {
        appendChild: (value) => {
          assert.equal(value, link);
          events.push("append");
        },
      },
      createElement: (name) => {
        assert.equal(name, "a");
        return link;
      },
    },
    url: {
      createObjectURL(value) {
        blob = value;
        events.push("blob");
        return "blob:local-gps";
      },
      revokeObjectURL(value) {
        assert.equal(value, "blob:local-gps");
        events.push("revoke");
      },
    },
    schedule(callback, delay) {
      assert.ok(delay >= 1000);
      cleanup = callback;
    },
    now: () => Date.parse("2026-10-28T12:34:56Z"),
  });
  assert.equal(await blob.text(), json);
  assert.match(blob.type, /^application\/json/);
  assert.equal(link.href, "blob:local-gps");
  assert.equal(link.download, "MIREA-V78-GPS-2026-10-28T12-34-56-000Z.json");
  assert.deepEqual(events, ["blob", "append", "click", "remove"]);
  cleanup();
  assert.deepEqual(events, ["blob", "append", "click", "remove", "revoke"]);
  assert.deepEqual(result, { method: "download", filename: link.download });
});

test("browser failure cleans its temporary link and URL, and unsupported download APIs report an error", async () => {
  let removed = false,
    revoked = false,
    cleanup;
  await assert.rejects(
    exportGpsCalibrationJson(json, {
      native: false,
      document: {
        body: { appendChild() {} },
        createElement: () => ({
          click() {
            throw new Error("download failed");
          },
          remove() {
            removed = true;
          },
        }),
      },
      url: {
        createObjectURL: () => "blob:local",
        revokeObjectURL() {
          revoked = true;
        },
      },
      schedule(callback) {
        cleanup = callback;
      },
    }),
    /download failed/,
  );
  assert.equal(removed, true);
  cleanup();
  assert.equal(revoked, true);
  await assert.rejects(
    exportGpsCalibrationJson(json, { native: false, document: null }),
    /браузер не поддерживает/,
  );
});
