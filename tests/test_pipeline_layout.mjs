import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  calculateSlotCanvasY,
  calculateStackContentHeight,
} from "../web/pipeline_editor.js";

test("pipeline panel height is based only on children, gaps and padding", () => {
  const height = calculateStackContentHeight([28, 116, 28], 8, 5, 9);

  assert.equal(height, 202);
});

test("pipeline layout never feeds the allocated container height back into sizing", async () => {
  const source = await readFile(new URL("../web/pipeline_editor.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /root\.scrollHeight/);
});

test("custom branch slot positions cannot push the DOM widget down every frame", async () => {
  const source = await readFile(new URL("../web/pipeline_editor.js", import.meta.url), "utf8");

  assert.match(source, /node\.widgets_start_y\s*=\s*PIPELINE_WIDGET_START_Y/);
  assert.doesNotMatch(source, /node\.computeSize\?\.\(\)/);
});

test("branch sockets include the DOM widget margin when aligning to rows", () => {
  assert.equal(calculateSlotCanvasY(4, 120, 10), 134);
});

test("dynamic socket labels do not expose internal branch ids", async () => {
  const source = await readFile(new URL("../web/pipeline_editor.js", import.meta.url), "utf8");

  assert.match(source, /input\.label\s*=\s*" "/);
  assert.doesNotMatch(source, /input\.label\s*=\s*""/);
});
