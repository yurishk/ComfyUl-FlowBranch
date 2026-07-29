import assert from "node:assert/strict";
import test from "node:test";

import {
  nextAvailablePairedPosition,
  pairedNodePosition,
  uniquePublisherNode,
} from "../web/node_actions.mjs";

test("paired reader is placed to the right without mutating its source", () => {
  const source = { pos: [100, 80], size: [250, 120] };

  assert.deepEqual(pairedNodePosition(source), [390, 80]);
  assert.deepEqual(source, { pos: [100, 80], size: [250, 120] });
});

test("additional paired readers avoid occupied node rectangles", () => {
  const source = { pos: [100, 80], size: [250, 120] };
  const reader = { size: [250, 80] };
  const occupied = { pos: [390, 80], size: [250, 80] };

  assert.deepEqual(
    nextAvailablePairedPosition(source, reader, [source, occupied]),
    [390, 178],
  );
});

test("navigation accepts repeated entries from the same pipeline node", () => {
  const pipeline = { id: 7 };

  assert.equal(uniquePublisherNode([
    { node: pipeline, key: "stage" },
    { node: pipeline, key: "final" },
  ]), pipeline);
});

test("navigation refuses ambiguous publisher nodes", () => {
  assert.equal(uniquePublisherNode([
    { node: { id: 1 } },
    { node: { id: 2 } },
  ]), null);
  assert.equal(uniquePublisherNode([]), null);
});
