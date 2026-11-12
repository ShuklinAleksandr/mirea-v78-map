import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { AtlasScene } from "../src/map/scene.js";
import { mapQuality } from "../src/map/quality.js";

const floor = JSON.parse(
  readFileSync(
    new URL("../public/data/campuses/v-78/v-78-floor2.json", import.meta.url),
    "utf8",
  ),
);
const landmarkId = "main-entrance-security-landmark";
const element = (tagName) => ({
  tagName: tagName.toUpperCase(),
  style: {},
  dataset: {},
  children: [],
  append(child) {
    this.children.push(child);
  },
  replaceChildren(...children) {
    this.children = children;
  },
});

for (const plan of [true, false]) {
  for (const quality of ["low", "balanced"]) {
    test(`real ${plan ? "2D" : "3D"} floor at ${quality} quality retains entrance landmarks and a noninteractive security label`, () => {
      const previousDocument = globalThis.document;
      const before = JSON.stringify(floor);
      const view = Object.assign(Object.create(AtlasScene.prototype), {
        plan,
        floorHeight: 3.6,
        wallHeight: 2.7,
        qualityProfile: mapQuality(quality, { plan }),
        model: new THREE.Group(),
        context: new THREE.Group(),
        selection: new THREE.Group(),
        hover: new THREE.Group(),
        labelLayer: element("div"),
        setRouteGuidance() {},
        invalidate() {},
        refreshUserLocation() {},
      });
      globalThis.document = { createElement: element };
      try {
        // Production setFloor uses the display overrides, entrance builder and
        // addLabel together. No renderer or GPU is needed for this regression.
        view.setFloor(floor, null, { fit: false });
        const entrance = view.model.getObjectByName(
          "Главный вход · двери, рамки и пост охраны",
        );
        assert.ok(entrance, "floor pipeline includes the entrance model");
        assert.equal(entrance.visible, true);
        assert.equal(entrance.children.length, 2);
        for (const mesh of entrance.children) {
          assert.equal(mesh.visible, true);
          assert.ok(mesh.geometry.attributes.position.count > 0);
          mesh.geometry.computeBoundingBox();
          const height =
            mesh.geometry.boundingBox.max.y - mesh.geometry.boundingBox.min.y;
          if (plan) {
            assert.ok(mesh.material.isMeshBasicMaterial);
            assert.ok(height < 1e-5, "2D landmarks are flat");
          } else {
            assert.ok(mesh.material.isMeshStandardMaterial);
            assert.ok(height > 1, "3D landmarks retain their volume");
          }
        }
        if (!plan)
          assert.equal(
            view.hallDetails.visible,
            quality !== "low",
            "decorative details still respect quality independently",
          );

        const labels = view.roomLabels.filter((l) => l.id === landmarkId);
        assert.equal(labels.length, 1);
        const label = labels[0];
        assert.equal(label.el.textContent, "Охрана");
        assert.equal(label.el.tagName, "SPAN");
        assert.equal(label.el.style.pointerEvents, "none");
        assert.equal(label.el.onclick, undefined);
        assert.equal(label.el.tabIndex, undefined);
        assert.ok(view.labelLayer.children.includes(label.el));
        assert.equal(label.position.x, entrance.userData.guard.center[0]);
        assert.equal(label.position.z, entrance.userData.guard.center[1]);
        assert.equal(label.position.y, plan ? 0.2 : 1.05);

        const roomButton = view.roomLabels.find(
          (l) => l.kind === "room" && l.id !== landmarkId,
        );
        assert.ok(roomButton, "ordinary room labels remain interactive");
        assert.equal(roomButton.el.tagName, "BUTTON");
        assert.equal(typeof roomButton.el.onclick, "function");
        assert.equal(view.pickables.includes(entrance), false);
        assert.ok(
          view.pickables.every(
            (object) =>
              !(object.userData.faceRooms || []).some(
                (room) => room.id === landmarkId,
              ),
          ),
          "security landmark does not create a selectable or routeable POI",
        );
        assert.equal(JSON.stringify(floor), before);
        view.clear();
        assert.equal(view.labelLayer.children.length, 0);
        assert.equal(view.roomLabels.length, 0);
        assert.equal(view.model.children.length, 0);
      } finally {
        view.clear();
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
      }
    });
  }
}
