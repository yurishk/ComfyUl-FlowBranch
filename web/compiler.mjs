import { branchInputName, parsePipelineConfig } from "./pipeline_config.mjs";

export const NODE_TYPES = Object.freeze({
  publish: "FlowBranchPublish",
  get: "FlowBranchGet",
  pipeline: "FlowBranchPipeline",
  legacyStage: "FlowBranchStage",
  legacyRoute: "FlowBranchRoute",
  legacyIf: "FlowBranchIf",
});

const LEGACY_PUBLISHERS = new Set([NODE_TYPES.legacyStage, NODE_TYPES.legacyRoute]);
const LEGACY_CONSUMERS = new Set([NODE_TYPES.legacyStage, NODE_TYPES.legacyRoute]);
const COMPILED_PROMPTS = new WeakMap();

export function normalizeChannel(value) {
  return String(value ?? "").trim();
}

export function generatedStageNodeId(pipelineId, stageIndex) {
  return `__flowbranch_stage__${String(pipelineId)}__${stageIndex}`;
}

function isLink(value) {
  return Array.isArray(value) && value.length === 2;
}

function outputChannel(node) {
  if (node.class_type === NODE_TYPES.publish) return normalizeChannel(node.inputs?.channel);
  if (LEGACY_PUBLISHERS.has(node.class_type)) return normalizeChannel(node.inputs?.output_channel);
  if (node.class_type === NODE_TYPES.pipeline) return normalizeChannel(node.inputs?.output_channel);
  return "";
}

function inputChannel(node) {
  if (node.class_type === NODE_TYPES.get) return normalizeChannel(node.inputs?.channel);
  if (LEGACY_CONSUMERS.has(node.class_type)) return normalizeChannel(node.inputs?.input_channel);
  if (node.class_type === NODE_TYPES.pipeline) return normalizeChannel(node.inputs?.input_channel);
  return "";
}

function publisherHasValue(node) {
  return node.class_type !== NODE_TYPES.publish
    || Object.prototype.hasOwnProperty.call(node.inputs || {}, "value");
}

function addPublisher(publishers, channel, publisher) {
  if (!channel) return;
  const matches = publishers.get(channel) || [];
  matches.push(publisher);
  publishers.set(channel, matches);
}

function channelConflictMessage(channel, matches) {
  const ids = matches.map((item) => `#${item.id}`).join("、");
  return `结果名称“${channel}”存在多个发布位置（${ids}），请改成唯一名称。`;
}

function resolvePublisher(publishers, channel, consumerId, excludedPipelineId = null) {
  const matches = (publishers.get(channel) || []).filter((item) => {
    if (String(item.id) === String(consumerId)) return false;
    if (excludedPipelineId !== null && String(item.pipelineId) === String(excludedPipelineId)) return false;
    return true;
  });
  if (matches.length === 1) return { link: [matches[0].id, 0], matches };
  if (matches.length > 1) return { error: channelConflictMessage(channel, matches), matches };
  return { matches };
}

function collectUpstreamFlowChannels(output, startLink) {
  const channels = new Set();
  const pending = isLink(startLink) ? [String(startLink[0])] : [];
  const visited = new Set();
  while (pending.length) {
    const nodeId = pending.pop();
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = output[nodeId];
    if (!node) continue;
    if (node.class_type === NODE_TYPES.get) channels.add(normalizeChannel(node.inputs?.channel));
    if (node.class_type === NODE_TYPES.publish) channels.add(normalizeChannel(node.inputs?.channel));
    if (node.class_type === NODE_TYPES.pipeline || LEGACY_PUBLISHERS.has(node.class_type)) {
      channels.add(outputChannel(node));
    }
    for (const value of Object.values(node.inputs || {})) {
      if (isLink(value)) pending.push(String(value[0]));
    }
  }
  channels.delete("");
  return channels;
}

function branchLinkIsAvailable(output, publishers, link, expectedInput) {
  if (!isLink(link)) return false;
  const source = output[String(link[0])];
  if (!source) return false;
  if (source.class_type === NODE_TYPES.get) {
    const channel = inputChannel(source);
    if (channel === expectedInput) return false;
    if (isLink(source.inputs?.fallback)) return true;
    return Boolean(resolvePublisher(publishers, channel, String(link[0])).link);
  }
  if (source.class_type === NODE_TYPES.publish) return publisherHasValue(source);
  return true;
}

function flowNodeIsUnavailable(node) {
  const inputs = node?.inputs || {};
  if (normalizeChannel(inputs.compile_error)) return false;
  if (node.class_type === NODE_TYPES.publish) return !publisherHasValue(node);
  if (node.class_type === NODE_TYPES.get) {
    return !isLink(inputs.source) && !isLink(inputs.fallback);
  }
  if (node.class_type === NODE_TYPES.pipeline) {
    return inputs.__stage_internal
      ? !isLink(inputs.selected_value) && !isLink(inputs.source)
      : !isLink(inputs.pipeline_result) && !isLink(inputs.source);
  }
  if (node.class_type === NODE_TYPES.legacyStage) {
    if (inputs.enabled !== false && isLink(inputs.processed)) return false;
    return !isLink(inputs.source);
  }
  if (node.class_type === NODE_TYPES.legacyRoute) {
    const optionName = {
      "方案 1": "option_1",
      "方案 2": "option_2",
      "方案 3": "option_3",
    }[inputs.route];
    if (optionName && isLink(inputs[optionName])) return false;
    return !isLink(inputs.source);
  }
  if (node.class_type === NODE_TYPES.legacyIf) {
    return !isLink(inputs.on_true) && !isLink(inputs.on_false);
  }
  return false;
}

function pruneUnavailableFlowLinks(output) {
  const unavailable = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [nodeId, node] of Object.entries(output)) {
      if (!unavailable.has(nodeId) && flowNodeIsUnavailable(node)) {
        unavailable.add(nodeId);
        changed = true;
      }
    }
    for (const node of Object.values(output)) {
      for (const [name, value] of Object.entries(node.inputs || {})) {
        if (!isLink(value)) continue;
        const sourceId = String(value[0]);
        if (unavailable.has(sourceId)) {
          delete node.inputs[name];
          changed = true;
        }
      }
    }
  }
  return unavailable;
}

function findLegacyCycleErrors(publishers) {
  const dependencyByOutput = new Map();
  for (const [channel, matches] of publishers) {
    if (matches.length !== 1) continue;
    const publisher = matches[0];
    if (!publisher.node || !LEGACY_PUBLISHERS.has(publisher.node.class_type)) continue;
    const dependency = inputChannel(publisher.node);
    if (dependency) dependencyByOutput.set(channel, { dependency, publisher });
  }

  const errors = new Map();
  for (const start of dependencyByOutput.keys()) {
    const path = [];
    const positions = new Map();
    let channel = start;
    while (dependencyByOutput.has(channel)) {
      if (positions.has(channel)) {
        const cycle = path.slice(positions.get(channel));
        const message = `结果名称存在循环依赖：${[...cycle, channel].join(" → ")}`;
        for (const item of cycle) errors.set(dependencyByOutput.get(item).publisher.id, message);
        break;
      }
      positions.set(channel, path.length);
      path.push(channel);
      channel = dependencyByOutput.get(channel).dependency;
    }
  }
  return errors;
}

function cleanCompilerInputs(node) {
  if (!node?.inputs) return;
  if (node.class_type === NODE_TYPES.get || LEGACY_CONSUMERS.has(node.class_type)) {
    delete node.inputs.source;
    node.inputs.compile_error = "";
  }
  if (node.class_type === NODE_TYPES.pipeline && !node.inputs.__stage_internal) {
    delete node.inputs.source;
    delete node.inputs.pipeline_result;
    node.inputs.compile_error = "";
  }
}

function makeGeneratedStage(pipeline, stage, stageIndex, expectedInput, sourceLink) {
  const id = generatedStageNodeId(pipeline.id, stageIndex);
  const inputs = {
    input_channel: expectedInput,
    output_channel: stage.name,
    pipeline_config: "{\"version\":2,\"stages\":[]}",
    __stage_internal: true,
    __flow_generated: true,
    stage_name: stage.name,
    compile_error: "",
  };
  if (sourceLink) inputs.source = sourceLink;
  return {
    id,
    node: {
      class_type: NODE_TYPES.pipeline,
      inputs,
      _meta: { title: `${pipeline.node._meta?.title || "流程编排器"} / ${stage.name}` },
    },
  };
}

function registerPublishers(nodes, pipelines) {
  const publishers = new Map();
  for (const item of nodes) {
    if (item.node.class_type === NODE_TYPES.publish && publisherHasValue(item.node)) {
      addPublisher(publishers, outputChannel(item.node), { ...item, pipelineId: null });
    } else if (LEGACY_PUBLISHERS.has(item.node.class_type)) {
      addPublisher(publishers, outputChannel(item.node), { ...item, pipelineId: null });
    }
  }
  for (const pipeline of pipelines) {
    pipeline.config.stages.forEach((stage, stageIndex) => {
      addPublisher(publishers, normalizeChannel(stage.name), {
        id: generatedStageNodeId(pipeline.id, stageIndex),
        node: null,
        pipelineId: pipeline.id,
        stageIndex,
      });
    });
    const finalChannel = outputChannel(pipeline.node);
    addPublisher(publishers, finalChannel, {
      id: pipeline.id,
      node: pipeline.node,
      pipelineId: pipeline.id,
      stageIndex: null,
    });
  }
  return publishers;
}

function compilePipeline(output, pipeline, publishers, diagnostics) {
  const inputs = pipeline.node.inputs || (pipeline.node.inputs = {});
  const errors = [];
  const warnings = [];
  const stageNames = new Set();
  const branchLinks = new Map();
  for (const [name, value] of Object.entries(inputs)) {
    if (name.startsWith("branch_") && isLink(value)) branchLinks.set(name, value);
  }

  const startChannel = inputChannel(pipeline.node);
  const finalChannel = outputChannel(pipeline.node);
  if (!startChannel) errors.push("起点结果名称不能为空。");
  if (!finalChannel) errors.push("最终发布名称不能为空。");

  for (const stage of pipeline.config.stages) {
    const stageName = normalizeChannel(stage.name);
    if (!stageName) errors.push("阶段结果名称不能为空。");
    else if (stageNames.has(stageName)) errors.push(`阶段结果名称“${stageName}”重复。`);
    stageNames.add(stageName);
  }

  for (const channel of [...stageNames, finalChannel].filter(Boolean)) {
    const matches = publishers.get(channel) || [];
    if (matches.length > 1) errors.push(channelConflictMessage(channel, matches));
  }

  const start = resolvePublisher(publishers, startChannel, pipeline.id, pipeline.id);
  if (start.error) errors.push(start.error);
  else if (!start.link && startChannel) {
    warnings.push(`起点结果“${startChannel}”本次没有可用数据，流程将保持为空。`);
  }

  let previousLink = start.link;
  let previousAvailable = Boolean(start.link);
  let expectedInput = startChannel;
  for (const [stageIndex, stage] of pipeline.config.stages.entries()) {
    const generated = makeGeneratedStage(
      pipeline,
      stage,
      stageIndex,
      expectedInput,
      previousAvailable ? previousLink : null,
    );
    const stageErrors = [...errors];
    if (stage.enabled && previousAvailable) {
      let selectedBranch = null;
      let selectedLink = null;
      if (stage.autoSelect) {
        const available = stage.branches.flatMap((branch) => {
          const link = branchLinks.get(branchInputName(branch.id));
          return branchLinkIsAvailable(output, publishers, link, expectedInput)
            ? [{ branch, link }]
            : [];
        });
        if (available.length) {
          ({ branch: selectedBranch, link: selectedLink } = available[0]);
          if (available.length > 1) {
            warnings.push(
              `阶段“${stage.name}”检测到多个可用方案，已按从上到下选择“${selectedBranch.name}”。`,
            );
          }
        } else {
          warnings.push(`阶段“${stage.name}”没有可用方案，将直接沿用上一阶段。`);
        }
      } else if (stage.selected) {
        selectedBranch = stage.branches.find((item) => item.id === stage.selected) || null;
        selectedLink = selectedBranch ? branchLinks.get(branchInputName(selectedBranch.id)) : null;
      }

      if (selectedBranch && selectedLink) {
        const upstreamChannels = collectUpstreamFlowChannels(output, selectedLink);
        if (!upstreamChannels.has(expectedInput)) {
          stageErrors.push(
            `阶段“${stage.name}”的方案“${selectedBranch.name}”必须读取上一阶段“${expectedInput}”，`
            + "否则会跳过前面的处理。",
          );
        } else {
          generated.node.inputs.selected_value = selectedLink;
          generated.node.inputs.selected_name = selectedBranch.name;
        }
      } else if (!stage.autoSelect && stage.selected && !selectedLink) {
        warnings.push(`阶段“${stage.name}”选中的方案未连接，将直接沿用上一阶段。`);
      }
    }
    if (stageErrors.length) generated.node.inputs.compile_error = [...new Set(stageErrors)].join(" ");
    output[generated.id] = generated.node;
    previousLink = [generated.id, 0];
    expectedInput = normalizeChannel(stage.name);
  }

  for (const name of [...Object.keys(inputs)]) {
    if (name.startsWith("branch_")) delete inputs[name];
  }

  if (previousAvailable && previousLink) inputs.pipeline_result = previousLink;
  if (errors.length) inputs.compile_error = [...new Set(errors)].join(" ");

  if (errors.length) {
    diagnostics.push({ nodeId: pipeline.id, level: "error", message: inputs.compile_error });
  } else if (warnings.length || pipeline.config.stages.length === 0) {
    diagnostics.push({
      nodeId: pipeline.id,
      level: "warning",
      message: warnings[0] || "尚未添加阶段，将直接传递起点结果。",
    });
  } else {
    diagnostics.push({
      nodeId: pipeline.id,
      level: "ok",
      message: `已编排 ${pipeline.config.stages.length} 个阶段。`,
    });
  }
}

function compileNamedConsumers(nodes, publishers, diagnostics) {
  const cycleErrors = findLegacyCycleErrors(publishers);
  for (const consumer of nodes) {
    if (consumer.node.class_type !== NODE_TYPES.get && !LEGACY_CONSUMERS.has(consumer.node.class_type)) {
      continue;
    }
    const inputs = consumer.node.inputs || (consumer.node.inputs = {});
    if (cycleErrors.has(consumer.id)) {
      inputs.compile_error = cycleErrors.get(consumer.id);
      diagnostics.push({ nodeId: consumer.id, level: "error", message: inputs.compile_error });
      continue;
    }
    const channel = inputChannel(consumer.node);
    if (!channel) {
      diagnostics.push({ nodeId: consumer.id, level: "warning", message: "读取结果名称为空。" });
      continue;
    }
    const resolved = resolvePublisher(publishers, channel, consumer.id);
    if (resolved.link) {
      inputs.source = resolved.link;
      diagnostics.push({ nodeId: consumer.id, level: "ok", message: `已读取“${channel}”。` });
    } else if (resolved.error) {
      inputs.compile_error = resolved.error;
      diagnostics.push({ nodeId: consumer.id, level: "error", message: resolved.error });
    } else {
      diagnostics.push({ nodeId: consumer.id, level: "warning", message: `找不到结果“${channel}”，运行时尝试回退。` });
    }
  }
}

export function inspectFlowPrompt(output) {
  const nodes = Object.entries(output || {}).map(([id, node]) => ({ id: String(id), node }));
  const pipelines = nodes
    .filter((item) => item.node.class_type === NODE_TYPES.pipeline && !item.node.inputs?.__stage_internal)
    .map((item) => ({ ...item, config: parsePipelineConfig(item.node.inputs?.pipeline_config) }));
  return { nodes, pipelines };
}

export function compileFlowPrompt(prompt) {
  if (!prompt || typeof prompt !== "object") return [];
  if (COMPILED_PROMPTS.has(prompt)) return COMPILED_PROMPTS.get(prompt);
  const output = prompt.output || (prompt.output = {});
  if (Object.values(output).some((node) => node?.inputs?.__flow_generated)) return [];

  const { nodes, pipelines } = inspectFlowPrompt(output);
  for (const item of nodes) cleanCompilerInputs(item.node);
  const publishers = registerPublishers(nodes, pipelines);
  const diagnostics = [];
  compileNamedConsumers(nodes, publishers, diagnostics);
  for (const pipeline of pipelines) compilePipeline(output, pipeline, publishers, diagnostics);
  pruneUnavailableFlowLinks(output);
  COMPILED_PROMPTS.set(prompt, diagnostics);
  return diagnostics;
}
