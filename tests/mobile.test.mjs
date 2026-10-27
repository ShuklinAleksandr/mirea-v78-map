import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeLinkHash, nativeShareLink } from "../src/mobile.js";

test("native links preserve unicode room ids and route endpoints", () => {
  const hash = nativeLinkHash(
    "mireamap://map#campus=v-78&room=Г-207&from=a&to=b",
  );
  const params = new URLSearchParams(hash.slice(1));
  assert.equal(params.get("room"), "Г-207");
  assert.equal(params.get("from"), "a");
  assert.equal(params.get("to"), "b");
  assert.equal(nativeLinkHash(nativeShareLink(hash)), hash);
});

test("native links cannot navigate to arbitrary pages or inject settings", () => {
  for (const value of [
    "https://example.com/#campus=v-78",
    "javascript:alert(1)",
    "mireamap://attacker#room=a",
    "invalid",
    null,
  ]) {
    assert.equal(nativeLinkHash(value), null);
  }
  assert.equal(
    nativeLinkHash(
      "mireamap://map?campus=v-78&server=https://example.com&theme=evil",
    ),
    "#campus=v-78",
  );
  assert.equal(nativeLinkHash(`mireamap://map#room=${"x".repeat(201)}`), null);
});
