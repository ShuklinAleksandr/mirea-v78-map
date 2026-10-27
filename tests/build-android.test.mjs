import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeJavaProperty,
  sdkLocalProperties,
} from "../scripts/build-android.mjs";

test("Windows SDK path with Cyrillic and spaces is encoded as a Java property", () => {
  const sdk = String.raw`C:\Команда\SDK 36`;
  assert.equal(
    escapeJavaProperty(sdk),
    String.raw`C\:\\\u041a\u043e\u043c\u0430\u043d\u0434\u0430\\SDK\ 36`,
  );
  assert.match(escapeJavaProperty(sdk), /^[\x20-\x7e]+$/);
});

test("Java property escaping preserves separators, control characters and UTF-16 pairs", () => {
  assert.equal(
    escapeJavaProperty(" =:#!\\\t\n\r\f"),
    String.raw`\ \=\:\#\!\\\t\n\r\f`,
  );
  assert.equal(escapeJavaProperty("🗺"), String.raw`\ud83d\uddfa`);
});

test("local.properties replaces stale SDK values and preserves other local settings", () => {
  const existing = [
    "# Local configuration",
    "sdk.dir=/Users/admin/old\\",
    "  /continued-path",
    "ndk.dir=/keep/ndk",
    "sdk.dir=/another-stale-sdk",
    "custom.setting=true",
    "",
  ].join("\r\n");
  assert.equal(
    sdkLocalProperties(existing, String.raw`C:\SDK`),
    [
      "# Local configuration",
      "ndk.dir=/keep/ndk",
      "custom.setting=true",
      String.raw`sdk.dir=C\:\\SDK`,
      "",
    ].join("\n"),
  );
});

test("local.properties adds one sdk.dir when the file has not been created", () => {
  assert.equal(
    sdkLocalProperties("", "/opt/android-sdk"),
    "sdk.dir=/opt/android-sdk\n",
  );
});
