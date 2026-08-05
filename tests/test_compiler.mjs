import assert from "node:assert/strict";
import test from "node:test";

import { compileFlowPrompt, generatedStageNodeId } from "../web/compiler.mjs";
import { setFlowLocale } from "../web/i18n.mjs";
import { branchInputName } from "../web/pipeline_config.mjs";

setFlowLocale("zh-CN");

function node(classType, inputs) {
  return { class_type: classType, inputs: { ...inputs } };
}

function stage(id, name, branches = [], selected = null, enabled = true, autoSelect = false) {
  return { id, name, enabled, autoSelect, selected, branches };
}

function branch(id, name) {
  return { id, name };
}

function config(stages) {
  return JSON.stringify({ version: 2, stages });
}

test("an unlimited pipeline compiles into real ordered dependencies", () => {
  const face = branch("face", "修脸");
  const upscale = branch("upscale", "高清放大");
  const prompt = { output: {
    "1": node("FlowBranchPublish", { channel: "原始图像", value: ["100", 0] }),
    "10": node("FlowBranchGet", { channel: "原始图像" }),
    "20": node("FaceDetailer", { image: ["10", 0] }),
    "11": node("FlowBranchGet", { channel: "修脸后" }),
    "21": node("Upscaler", { image: ["11", 0] }),
    "2": node("FlowBranchPipeline", {
      input_channel: "原始图像",
      output_channel: "最终图像",
      pipeline_config: config([
        stage("face-stage", "修脸后", [face], face.id),
        stage("upscale-stage", "放大后", [upscale], upscale.id),
      ]),
      [branchInputName(face.id)]: ["20", 0],
      [branchInputName(upscale.id)]: ["21", 0],
    }),
    "3": node("FlowBranchGet", { channel: "最终图像" }),
  } };

  const diagnostics = compileFlowPrompt(prompt);
  const firstStage = generatedStageNodeId("2", 0);
  const secondStage = generatedStageNodeId("2", 1);

  assert.deepEqual(prompt.output["10"].inputs.source, ["1", 0]);
  assert.deepEqual(prompt.output[firstStage].inputs.source, ["1", 0]);
  assert.deepEqual(prompt.output[firstStage].inputs.selected_value, ["20", 0]);
  assert.deepEqual(prompt.output["11"].inputs.source, [firstStage, 0]);
  assert.deepEqual(prompt.output[secondStage].inputs.source, [firstStage, 0]);
  assert.deepEqual(prompt.output[secondStage].inputs.selected_value, ["21", 0]);
  assert.deepEqual(prompt.output["2"].inputs.pipeline_result, [secondStage, 0]);
  assert.deepEqual(prompt.output["3"].inputs.source, ["2", 0]);
  assert.equal(prompt.output["2"].inputs[branchInputName(face.id)], undefined);
  assert.equal(diagnostics.some((item) => item.level === "error"), false);
});

test("one stage accepts more than three branches", () => {
  const branches = Array.from({ length: 12 }, (_, index) => branch(`b${index + 1}`, `方案 ${index + 1}`));
  const selected = branches.at(-1);
  const prompt = { output: {
    "1": node("FlowBranchPublish", { channel: "输入图像", value: ["100", 0] }),
    "10": node("FlowBranchGet", { channel: "输入图像" }),
    "20": node("SelectedProcessor", { image: ["10", 0] }),
    "2": node("FlowBranchPipeline", {
      input_channel: "输入图像",
      output_channel: "输出图像",
      pipeline_config: config([stage("s1", "处理后", branches, selected.id)]),
      [branchInputName(selected.id)]: ["20", 0],
    }),
  } };

  compileFlowPrompt(prompt);

  assert.deepEqual(
    prompt.output[generatedStageNodeId("2", 0)].inputs.selected_value,
    ["20", 0],
  );
});

test("automatic selection picks the first branch whose named result survived bypass", () => {
  const basic = branch("basic", "基础放大");
  const sd = branch("sd", "SD 放大");
  const gpu = branch("gpu", "GPU 放大");
  const prompt = { output: {
    "1": node("FlowBranchPublish", { channel: "修脸结果", value: ["100", 0] }),
    "10": node("FlowBranchGet", { channel: "基础放大" }),
    "11": node("FlowBranchGet", { channel: "SD 放大" }),
    "12": node("FlowBranchGet", { channel: "GPU 放大" }),
    "20": node("FlowBranchGet", { channel: "修脸结果" }),
    "21": node("GpuUpscaler", { image: ["20", 0] }),
    "22": node("FlowBranchPublish", { channel: "GPU 放大", value: ["21", 0] }),
    "2": node("FlowBranchPipeline", {
      input_channel: "修脸结果",
      output_channel: "最终图像",
      pipeline_config: config([
        stage("upscale", "放大结果", [basic, sd, gpu], null, true, true),
      ]),
      [branchInputName(basic.id)]: ["10", 0],
      [branchInputName(sd.id)]: ["11", 0],
      [branchInputName(gpu.id)]: ["12", 0],
    }),
  } };

  compileFlowPrompt(prompt);

  const generated = prompt.output[generatedStageNodeId("2", 0)];
  assert.deepEqual(generated.inputs.selected_value, ["12", 0]);
  assert.equal(generated.inputs.selected_name, "GPU 放大");
  assert.deepEqual(prompt.output["12"].inputs.source, ["22", 0]);
  assert.equal(prompt.output["10"].inputs.source, undefined);
  assert.equal(prompt.output["11"].inputs.source, undefined);
});

test("automatic selection ignores a bypassed direct branch that became the previous result", () => {
  const bypassed = branch("bypassed", "已旁路方案");
  const active = branch("active", "有效方案");
  const prompt = { output: {
    "1": node("FlowBranchPublish", { channel: "输入", value: ["100", 0] }),
    "10": node("FlowBranchGet", { channel: "输入" }),
    "20": node("ActiveProcessor", { image: ["10", 0] }),
    "2": node("FlowBranchPipeline", {
      input_channel: "输入",
      output_channel: "输出",
      pipeline_config: config([
        stage("auto", "处理结果", [bypassed, active], null, true, true),
      ]),
      [branchInputName(bypassed.id)]: ["10", 0],
      [branchInputName(active.id)]: ["20", 0],
    }),
  } };

  compileFlowPrompt(prompt);

  const generated = prompt.output[generatedStageNodeId("2", 0)];
  assert.deepEqual(generated.inputs.selected_value, ["20", 0]);
  assert.equal(generated.inputs.selected_name, "有效方案");
});

test("one pipeline accepts far more than three stages", () => {
  const stages = Array.from({ length: 20 }, (_, index) => (
    stage(`s${index}`, `阶段 ${index + 1} 后`, [], null, false)
  ));
  const prompt = { output: {
    "1": node("FlowBranchPublish", { channel: "输入", value: ["100", 0] }),
    "2": node("FlowBranchPipeline", {
      input_channel: "输入",
      output_channel: "输出",
      pipeline_config: config(stages),
    }),
  } };

  compileFlowPrompt(prompt);

  for (let index = 0; index < stages.length; index += 1) {
    const generatedId = generatedStageNodeId("2", index);
    assert.ok(prompt.output[generatedId]);
    const expectedSource = index === 0 ? ["1", 0] : [generatedStageNodeId("2", index - 1), 0];
    assert.deepEqual(prompt.output[generatedId].inputs.source, expectedSource);
  }
  assert.deepEqual(prompt.output["2"].inputs.pipeline_result, [generatedStageNodeId("2", 19), 0]);
});

test("a selected branch must read the immediately previous result", () => {
  const selected = branch("wrong", "错误方案");
  const prompt = { output: {
    "1": node("FlowBranchPublish", { channel: "原始图像", value: ["100", 0] }),
    "10": node("FlowBranchGet", { channel: "另一个结果" }),
    "20": node("Processor", { image: ["10", 0] }),
    "2": node("FlowBranchPipeline", {
      input_channel: "原始图像",
      output_channel: "最终图像",
      pipeline_config: config([stage("s1", "处理后", [selected], selected.id)]),
      [branchInputName(selected.id)]: ["20", 0],
    }),
  } };

  compileFlowPrompt(prompt);
  const generated = prompt.output[generatedStageNodeId("2", 0)];

  assert.match(generated.inputs.compile_error, /必须读取上一阶段.*原始图像/);
  assert.equal(generated.inputs.selected_value, undefined);
});

test("disabled and unconnected stages bypass to the previous result", () => {
  const ignored = branch("ignored", "不会执行");
  const prompt = { output: {
    "1": node("FlowBranchPublish", { channel: "输入", value: ["100", 0] }),
    "2": node("FlowBranchPipeline", {
      input_channel: "输入",
      output_channel: "输出",
      pipeline_config: config([
        stage("disabled", "阶段一", [ignored], ignored.id, false),
        stage("empty", "阶段二", [], null, true),
      ]),
      [branchInputName(ignored.id)]: ["99", 0],
    }),
  } };

  compileFlowPrompt(prompt);
  const firstStage = prompt.output[generatedStageNodeId("2", 0)];
  const secondStage = prompt.output[generatedStageNodeId("2", 1)];

  assert.equal(firstStage.inputs.selected_value, undefined);
  assert.deepEqual(firstStage.inputs.source, ["1", 0]);
  assert.equal(secondStage.inputs.selected_value, undefined);
  assert.deepEqual(secondStage.inputs.source, [generatedStageNodeId("2", 0), 0]);
});

test("a pipeline whose entire input chain was bypassed compiles as an empty branch", () => {
  const missing = branch("missing", "已绕过方案");
  const prompt = { output: {
    "10": node("FlowBranchGet", { channel: "已绕过方案" }),
    "2": node("FlowBranchPipeline", {
      input_channel: "已绕过起点",
      output_channel: "最终结果",
      pipeline_config: config([
        stage("s1", "处理结果", [missing], null, true, true),
      ]),
      [branchInputName(missing.id)]: ["10", 0],
    }),
    "3": node("FlowBranchGet", { channel: "最终结果" }),
    "4": node("OptionalImageConsumer", {
      text: "仍然执行",
      optional_image: ["3", 0],
    }),
  } };

  const diagnostics = compileFlowPrompt(prompt);
  const generatedId = generatedStageNodeId("2", 0);

  assert.equal(prompt.output[generatedId].inputs.source, undefined);
  assert.equal(prompt.output[generatedId].inputs.selected_value, undefined);
  assert.equal(prompt.output[generatedId].inputs.compile_error, "");
  assert.equal(prompt.output["2"].inputs.compile_error, "");
  assert.equal(prompt.output["2"].inputs.pipeline_result, undefined);
  assert.equal(prompt.output["3"].inputs.source, undefined);
  assert.equal(prompt.output["4"].inputs.optional_image, undefined);
  assert.equal(prompt.output["4"].inputs.text, "仍然执行");
  assert.equal(diagnostics.some((item) => item.level === "error"), false);
});

test("a missing named result is removed exactly like an unconnected optional input", () => {
  const prompt = { output: {
    "1": node("FlowBranchGet", { channel: "参考图像" }),
    "274": node("TextEncodeQwenImageEditPlus", {
      prompt: "保留这个输入",
      reference_image: ["1", 0],
    }),
  } };

  compileFlowPrompt(prompt);

  assert.equal(prompt.output["274"].inputs.reference_image, undefined);
  assert.equal(prompt.output["274"].inputs.prompt, "保留这个输入");
});

test("a missing named source activates a connected fallback instead of pruning the reader", () => {
  const prompt = { output: {
    "9": node("FallbackImage", { value: "fallback" }),
    "1": node("FlowBranchGet", { channel: "参考图像", fallback: ["9", 0] }),
    "274": node("OptionalImageConsumer", { image: ["1", 0] }),
  } };

  compileFlowPrompt(prompt);

  assert.deepEqual(prompt.output["1"].inputs.fallback, ["9", 0]);
  assert.deepEqual(prompt.output["274"].inputs.image, ["1", 0]);
});

test("an empty sender connected directly to an optional input is pruned", () => {
  const prompt = { output: {
    "1": node("FlowBranchPublish", { channel: "空结果" }),
    "2": node("OptionalConsumer", { optional_value: ["1", 0], keep: 42 }),
  } };

  compileFlowPrompt(prompt);

  assert.equal(prompt.output["2"].inputs.optional_value, undefined);
  assert.equal(prompt.output["2"].inputs.keep, 42);
});

test("a pipeline with no stages is a named passthrough", () => {
  const prompt = { output: {
    "1": node("FlowBranchPublish", { channel: "输入", value: ["100", 0] }),
    "2": node("FlowBranchPipeline", {
      input_channel: "输入",
      output_channel: "输出",
      pipeline_config: config([]),
    }),
    "3": node("FlowBranchGet", { channel: "输出" }),
  } };

  compileFlowPrompt(prompt);

  assert.deepEqual(prompt.output["2"].inputs.pipeline_result, ["1", 0]);
  assert.deepEqual(prompt.output["3"].inputs.source, ["2", 0]);
});

test("duplicate stage result names become clear blockers", () => {
  const prompt = { output: {
    "1": node("FlowBranchPublish", { channel: "输入", value: ["100", 0] }),
    "2": node("FlowBranchPipeline", {
      input_channel: "输入",
      output_channel: "输出",
      pipeline_config: config([
        stage("s1", "重复名称"),
        stage("s2", "重复名称"),
      ]),
    }),
    "3": node("FlowBranchGet", { channel: "输出" }),
    "4": node("OptionalConsumer", { value: ["3", 0] }),
  } };

  compileFlowPrompt(prompt);

  assert.match(prompt.output["2"].inputs.compile_error, /阶段结果名称.*重复/);
  assert.deepEqual(prompt.output["3"].inputs.source, ["2", 0]);
  assert.deepEqual(prompt.output["4"].inputs.value, ["3", 0]);
});

test("an empty sender is unavailable and compilation does not throw", () => {
  const prompt = { output: {
    "1": node("FlowBranchPublish", { channel: "输入" }),
    "2": node("FlowBranchGet", { channel: "输入" }),
  } };

  assert.doesNotThrow(() => compileFlowPrompt(prompt));
  assert.equal(prompt.output["2"].inputs.source, undefined);
  assert.equal(prompt.output["2"].inputs.compile_error, "");
});

test("compilation never mutates unrelated nodes or random seed widgets", () => {
  const samplerInputs = {
    noise_seed: -1,
    control_after_generate: "randomize",
    steps: 20,
  };
  const prompt = { output: {
    "10": node("KSamplerAdvEfficient", samplerInputs),
    "11": node("FlowBranchGet", { channel: "missing" }),
  } };
  const before = structuredClone(prompt.output["10"]);

  compileFlowPrompt(prompt);

  assert.deepEqual(prompt.output["10"], before);
});

test("compiling the same queued prompt twice does not duplicate generated stages", () => {
  const prompt = { output: {
    "1": node("FlowBranchPublish", { channel: "输入", value: ["100", 0] }),
    "2": node("FlowBranchPipeline", {
      input_channel: "输入",
      output_channel: "输出",
      pipeline_config: config([stage("s1", "处理后")]),
    }),
  } };

  compileFlowPrompt(prompt);
  const firstIds = Object.keys(prompt.output).filter((id) => id.startsWith("__flowbranch_stage__"));
  compileFlowPrompt(prompt);
  const secondIds = Object.keys(prompt.output).filter((id) => id.startsWith("__flowbranch_stage__"));

  assert.deepEqual(secondIds, firstIds);
});

test("saved workflows using legacy stage nodes still compile", () => {
  const prompt = { output: {
    "1": node("FlowBranchPublish", { channel: "原始图像", value: ["100", 0] }),
    "2": node("FlowBranchStage", {
      input_channel: "原始图像",
      output_channel: "旧版阶段结果",
      enabled: false,
    }),
    "3": node("FlowBranchGet", { channel: "旧版阶段结果" }),
  } };

  compileFlowPrompt(prompt);

  assert.deepEqual(prompt.output["2"].inputs.source, ["1", 0]);
  assert.deepEqual(prompt.output["3"].inputs.source, ["2", 0]);
});
