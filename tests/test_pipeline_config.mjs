import assert from "node:assert/strict";
import test from "node:test";
import { setFlowLocale } from "../web/i18n.mjs";

import {
  branchInputName,
  createBranch,
  createStage,
  normalizePipelineConfig,
  parsePipelineConfig,
  serializePipelineConfig,
} from "../web/pipeline_config.mjs";

setFlowLocale("zh-CN");

test("configuration keeps an unlimited number of stages and branches", () => {
  const stages = Array.from({ length: 20 }, (_, stageIndex) => ({
    id: `s${stageIndex}`,
    name: `阶段 ${stageIndex + 1} 后`,
    enabled: true,
    autoSelect: stageIndex % 2 === 0,
    selected: `s${stageIndex}_b29`,
    branches: Array.from({ length: 30 }, (_, branchIndex) => ({
      id: `s${stageIndex}_b${branchIndex}`,
      name: `方案 ${branchIndex + 1}`,
    })),
  }));

  const normalized = normalizePipelineConfig({ version: 2, stages });

  assert.equal(normalized.stages.length, 20);
  assert.equal(normalized.stages[19].branches.length, 30);
  assert.equal(normalized.stages[19].selected, "s19_b29");
  assert.equal(normalized.stages[18].autoSelect, true);
  assert.equal(normalized.stages[19].autoSelect, false);
});

test("malformed configuration becomes a safe empty pipeline", () => {
  assert.deepEqual(parsePipelineConfig("not json").stages, []);
  assert.deepEqual(parsePipelineConfig(null).stages, []);
});

test("new rows use stable ids and readable names", () => {
  const first = createStage(1);
  const second = createStage(2);
  const option = createBranch(4);

  assert.notEqual(first.id, second.id);
  assert.equal(first.name, "阶段 1 结果");
  assert.equal(first.autoSelect, false);
  assert.equal(option.name, "方案 4");
  assert.match(branchInputName(option.id), /^branch_[A-Za-z0-9_-]+$/);
});

test("an explicitly cleared stage name stays empty for validation", () => {
  const normalized = normalizePipelineConfig({
    stages: [{ id: "s1", name: "", enabled: true, selected: null, branches: [] }],
  });

  assert.equal(normalized.stages[0].name, "");
});

test("copy and workflow reload preserve ids order switches and selection", () => {
  const original = {
    stages: [
      {
        id: "face-stage",
        name: "修脸后",
        enabled: false,
        autoSelect: false,
        selected: "codeformer",
        branches: [
          { id: "facedetailer", name: "FaceDetailer" },
          { id: "codeformer", name: "CodeFormer" },
        ],
      },
      {
        id: "upscale-stage",
        name: "放大后",
        enabled: true,
        autoSelect: true,
        selected: null,
        branches: [],
      },
    ],
  };

  const restored = parsePipelineConfig(serializePipelineConfig(original));

  assert.deepEqual(restored, { version: 2, ...original });
});
