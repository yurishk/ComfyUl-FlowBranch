import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { compileFlowPrompt, NODE_TYPES, normalizeChannel } from "./compiler.mjs";
import { nextAvailablePairedPosition, uniquePublisherNode } from "./node_actions.mjs";
import { parsePipelineConfig } from "./pipeline_config.mjs";
import { PIPELINE_NODE_MIN_WIDTH, setupPipelineEditor } from "./pipeline_editor.js";

const FLOW_TYPES = new Set(Object.values(NODE_TYPES));
const LEGACY_PUBLISHERS = new Set([NODE_TYPES.legacyStage, NODE_TYPES.legacyRoute]);
const LEGACY_CONSUMERS = new Set([NODE_TYPES.legacyStage, NODE_TYPES.legacyRoute]);
const COLORS = { ok: "#56b889", warning: "#d9a441", error: "#df6666", idle: "#7b8492" };
const STATUS_PRIORITY = { idle: 0, ok: 1, warning: 2, error: 3 };
const INACTIVE_MODES = new Set([2, 4]);
const INTERNAL_INPUTS = ["source", "pipeline_result", "selected_value"];
const INTERNAL_WIDGETS = [
  "compile_error",
  "pipeline_config",
  "stage_name",
  "selected_name",
  "__stage_internal",
  "__flow_generated",
];
const LABELS = {
  channel: "结果名称",
  value: "数据",
  fallback: "找不到时使用",
  input_channel: "起点结果",
  output_channel: "最终发布为",
  enabled: "启用阶段",
  processed: "处理结果",
  route: "选择方案",
  option_1: "方案 1 结果",
  option_2: "方案 2 结果",
  option_3: "方案 3 结果",
  condition: "条件",
  on_true: "为真时",
  on_false: "为假时",
};
const OUTPUT_LABELS = {
  [NODE_TYPES.publish]: "数据",
  [NODE_TYPES.get]: "数据",
  [NODE_TYPES.pipeline]: "流程结果",
  [NODE_TYPES.legacyStage]: "阶段结果",
  [NODE_TYPES.legacyRoute]: "选择结果",
  [NODE_TYPES.legacyIf]: "选择结果",
};
let refreshPending = false;

function ensureStyles() {
  const id = "flow-branch-styles";
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = new URL("./flow_branch.css", import.meta.url).href;
  document.head.append(link);
}

function nodeType(node) {
  return node?.comfyClass || node?.type || "";
}

function widget(node, name) {
  return node.widgets?.find((item) => item.name === name);
}

function input(node, name) {
  return node.inputs?.find((item) => item.name === name);
}

function isConnected(slot) {
  return slot?.link !== null && slot?.link !== undefined;
}

function channelFor(node, direction) {
  const type = nodeType(node);
  const name = direction === "out"
    ? (type === NODE_TYPES.publish ? "channel" : "output_channel")
    : (type === NODE_TYPES.get ? "channel" : "input_channel");
  return normalizeChannel(widget(node, name)?.value);
}

function removeInputByName(node, name) {
  const index = node.inputs?.findIndex((item) => item.name === name) ?? -1;
  if (index >= 0) node.removeInput(index);
}

function hideWidget(item) {
  if (!item) return;
  item.hidden = true;
  item.computeSize = () => [0, -4];
  item.options = { ...(item.options || {}), serialize: true };
}

function hideInternalControls(node) {
  for (const name of INTERNAL_INPUTS) removeInputByName(node, name);
  for (const name of INTERNAL_WIDGETS) hideWidget(widget(node, name));
}

function applyChineseLabels(node) {
  for (const item of node.widgets || []) {
    if (LABELS[item.name]) item.label = LABELS[item.name];
  }
  for (const item of node.inputs || []) {
    if (LABELS[item.name]) item.label = LABELS[item.name];
  }
  const outputLabel = OUTPUT_LABELS[nodeType(node)];
  if (outputLabel && node.outputs?.[0]) node.outputs[0].label = outputLabel;
}

function setStatus(node, level, text, detail = text) {
  node.__flowBranchStatus = { level, text, detail };
  node.boxcolor = COLORS[level] || COLORS.idle;
}

function setHigherPriorityStatus(node, level, text, detail = text) {
  const current = node.__flowBranchStatus;
  if (!current || STATUS_PRIORITY[level] >= STATUS_PRIORITY[current.level]) {
    setStatus(node, level, text, detail);
  }
}

function addPublisher(publishers, channel, node, key = channel) {
  if (!channel) return;
  const matches = publishers.get(channel) || [];
  matches.push({ node, key });
  publishers.set(channel, matches);
}

function publisherHasValue(node) {
  return nodeType(node) !== NODE_TYPES.publish || isConnected(input(node, "value"));
}

function registerPublishers(nodes, requireValue = true) {
  const publishers = new Map();
  for (const node of nodes) {
    const type = nodeType(node);
    if (type === NODE_TYPES.publish) {
      const channel = channelFor(node, "out");
      if (!requireValue || publisherHasValue(node)) addPublisher(publishers, channel, node);
    } else if (LEGACY_PUBLISHERS.has(type)) {
      addPublisher(publishers, channelFor(node, "out"), node);
    } else if (type === NODE_TYPES.pipeline) {
      const config = parsePipelineConfig(widget(node, "pipeline_config")?.value);
      for (const stage of config.stages) addPublisher(publishers, normalizeChannel(stage.name), node, stage.id);
      addPublisher(publishers, channelFor(node, "out"), node, "final");
    }
  }
  return publishers;
}

function registerLivePublishers(nodes) {
  return registerPublishers(nodes, true);
}

function graphPublishers(graph) {
  return registerPublishers(graph?._nodes || [], false);
}

function createReaderNode(sourceNode, channel) {
  const normalized = normalizeChannel(channel);
  const graph = sourceNode?.graph || app.graph;
  const reader = globalThis.LiteGraph?.createNode?.(NODE_TYPES.get);
  if (!normalized || !graph || !reader) return null;

  reader.pos = nextAvailablePairedPosition(sourceNode, reader, graph._nodes || []);
  graph.add(reader);
  const channelWidget = widget(reader, "channel");
  if (channelWidget) {
    channelWidget.value = normalized;
    channelWidget.callback?.(normalized);
  }
  if (app.canvas?.graph === graph) app.canvas.selectNode?.(reader, false);
  graph.setDirtyCanvas?.(true, true);
  scheduleDiagnostics();
  return reader;
}

function publisherForReader(node) {
  const channel = channelFor(node, "in");
  if (!channel) return null;
  return uniquePublisherNode(graphPublishers(node.graph || app.graph).get(channel));
}

function jumpToNode(target) {
  if (!target || app.canvas?.graph !== target.graph) return;
  app.canvas.centerOnNode?.(target);
  app.canvas.selectNode?.(target, false);
  app.canvas.setDirty?.(true, true);
}

function pipelineReaderMenu(node) {
  const config = parsePipelineConfig(widget(node, "pipeline_config")?.value);
  const options = [];
  for (const [index, stage] of config.stages.entries()) {
    const channel = normalizeChannel(stage.name);
    if (!channel) continue;
    options.push({
      content: `阶段 ${index + 1}：${channel}`,
      callback: () => createReaderNode(node, channel),
    });
  }
  const finalChannel = channelFor(node, "out");
  if (finalChannel) {
    if (options.length) options.push(null);
    options.push({
      content: `最终结果：${finalChannel}`,
      callback: () => createReaderNode(node, finalChannel),
    });
  }
  return options;
}

function flowNodeMenuItems(node) {
  const type = nodeType(node);
  if (type === NODE_TYPES.publish) {
    const channel = channelFor(node, "out");
    return channel ? [{
      content: `创建配对读取：${channel}`,
      callback: () => createReaderNode(node, channel),
    }] : [];
  }
  if (type === NODE_TYPES.pipeline) {
    const options = pipelineReaderMenu(node);
    return options.length ? [{
      content: "创建结果读取节点",
      has_submenu: true,
      submenu: { options },
    }] : [];
  }
  if (type === NODE_TYPES.get) {
    const publisher = publisherForReader(node);
    return publisher ? [{
      content: "跳转到发送位置",
      callback: () => jumpToNode(publisher),
    }] : [];
  }
  return [];
}

function diagnosePublishers(nodes, publishers) {
  for (const node of nodes) {
    const type = nodeType(node);
    if (type === NODE_TYPES.publish) {
      const channel = channelFor(node, "out");
      if (!channel) setStatus(node, "warning", "结果名称为空");
      else if (!publisherHasValue(node)) setStatus(node, "warning", `未接数据 ${channel}`);
      else {
        const matches = publishers.get(channel) || [];
        setStatus(
          node,
          matches.length > 1 ? "error" : "ok",
          matches.length > 1 ? `名称冲突 ${channel}` : `发布 ${channel}`,
        );
      }
    }
  }
}

function diagnosePipeline(node, publishers) {
  const config = parsePipelineConfig(widget(node, "pipeline_config")?.value);
  const start = channelFor(node, "in");
  const finalName = channelFor(node, "out");
  const names = config.stages.map((stage) => normalizeChannel(stage.name));
  const duplicate = names.find((name, index) => name && names.indexOf(name) !== index);
  if (!start) setStatus(node, "error", "起点名称为空");
  else if (!finalName) setStatus(node, "error", "最终名称为空");
  else if (names.some((name) => !name)) setStatus(node, "error", "阶段名称为空");
  else if (duplicate) setStatus(node, "error", `阶段重名 ${duplicate}`);
  else {
    const ownNames = new Set([...names, finalName]);
    const conflict = [...ownNames].find((name) => (publishers.get(name) || []).length > 1);
    const sources = (publishers.get(start) || []).filter((item) => item.node !== node);
    if (conflict) setStatus(node, "error", `名称冲突 ${conflict}`);
    else if (sources.length === 0) setStatus(node, "warning", `缺少起点 ${start}`);
    else if (sources.length > 1) setStatus(node, "error", `起点冲突 ${start}`);
    else if (config.stages.length === 0) setStatus(node, "warning", "尚未添加阶段");
    else setStatus(node, "ok", `${config.stages.length} 个阶段`);
  }
}

function diagnoseConsumer(node, publishers) {
  const type = nodeType(node);
  if (type !== NODE_TYPES.get && !LEGACY_CONSUMERS.has(type)) return;
  const channel = channelFor(node, "in");
  const matches = (publishers.get(channel) || []).filter((item) => item.node !== node);
  if (!channel) setHigherPriorityStatus(node, "warning", "读取名称为空");
  else if (matches.length === 1) setHigherPriorityStatus(node, "ok", `读取 ${channel}`);
  else if (matches.length > 1) setHigherPriorityStatus(node, "error", `名称冲突 ${channel}`);
  else setHigherPriorityStatus(node, "warning", `未找到 ${channel}`);
}

function refreshDiagnostics() {
  refreshPending = false;
  const allNodes = (app.graph?._nodes || []).filter((node) => FLOW_TYPES.has(nodeType(node)));
  const nodes = allNodes.filter((node) => !INACTIVE_MODES.has(node.mode));
  for (const node of allNodes) setStatus(node, "idle", "已停用");
  for (const node of nodes) setStatus(node, "idle", "待检查");
  const publishers = registerLivePublishers(nodes);
  diagnosePublishers(nodes, publishers);
  for (const node of nodes) {
    if (nodeType(node) === NODE_TYPES.pipeline) diagnosePipeline(node, publishers);
    diagnoseConsumer(node, publishers);
    if (nodeType(node) === NODE_TYPES.legacyIf) setStatus(node, "idle", "旧版节点");
  }
  app.graph?.setDirtyCanvas(true, true);
}

function scheduleDiagnostics() {
  if (refreshPending) return;
  refreshPending = true;
  requestAnimationFrame(refreshDiagnostics);
}

function wrapWidget(widgetItem, node) {
  if (!widgetItem || widgetItem.__flowBranchWrapped) return;
  widgetItem.__flowBranchWrapped = true;
  const original = widgetItem.callback;
  widgetItem.callback = function () {
    const result = original?.apply(this, arguments);
    if (nodeType(node) === NODE_TYPES.pipeline && widgetItem.name === "input_channel") {
      node.__flowPipelineEditor?.render();
    }
    scheduleDiagnostics();
    return result;
  };
}

function fitStatusText(ctx, text, maxWidth) {
  if (maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  let shortened = text;
  while (shortened.length > 1 && ctx.measureText(`${shortened}...`).width > maxWidth) {
    shortened = shortened.slice(0, -1);
  }
  return shortened.length ? `${shortened}...` : "";
}

function setupNode(node, reload = false) {
  hideInternalControls(node);
  applyChineseLabels(node);
  const minWidth = nodeType(node) === NODE_TYPES.pipeline ? PIPELINE_NODE_MIN_WIDTH : 250;
  node.setSize([Math.max(node.size[0], minWidth), node.size[1]]);

  if (node.__flowBranchSetup) {
    if (reload) node.__flowPipelineEditor?.reload();
    scheduleDiagnostics();
    return;
  }
  node.__flowBranchSetup = true;

  for (const name of ["channel", "input_channel", "output_channel"]) {
    wrapWidget(widget(node, name), node);
  }

  if (nodeType(node) === NODE_TYPES.pipeline) {
    setupPipelineEditor(node, app, scheduleDiagnostics);
  }

  if (nodeType(node) === NODE_TYPES.get) {
    const originalDoubleClick = node.onDblClick;
    node.onDblClick = function () {
      const publisher = publisherForReader(this);
      if (publisher) {
        jumpToNode(publisher);
        return;
      }
      return originalDoubleClick?.apply(this, arguments);
    };
  }

  const originalConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    const result = originalConnectionsChange?.apply(this, arguments);
    this.__flowPipelineEditor?.refreshConnections();
    scheduleDiagnostics();
    return result;
  };

  const originalSerialize = node.onSerialize;
  node.onSerialize = function () {
    this.__flowPipelineEditor?.persist();
    return originalSerialize?.apply(this, arguments);
  };

  const originalRemoved = node.onRemoved;
  node.onRemoved = function () {
    this.__flowPipelineEditor?.destroy();
    const result = originalRemoved?.apply(this, arguments);
    scheduleDiagnostics();
    return result;
  };

  const originalModeChange = node.onModeChange;
  node.onModeChange = function () {
    const result = originalModeChange?.apply(this, arguments);
    scheduleDiagnostics();
    return result;
  };

  const originalDraw = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    originalDraw?.apply(this, arguments);
    this.__flowPipelineEditor?.updateCanvasPositions();
    const status = this.__flowBranchStatus;
    if (!status || this.flags?.collapsed) return;
    ctx.save();
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = COLORS[status.level] || COLORS.idle;
    const title = String(this.getTitle?.() || this.title || "");
    const titleWidth = ctx.measureText(title).width;
    const maxWidth = Math.max(0, this.size[0] - titleWidth - 48);
    const text = fitStatusText(ctx, status.text, maxWidth);
    if (text) ctx.fillText(text, this.size[0] - 10, -15);
    ctx.restore();
  };
  scheduleDiagnostics();
}

function installPromptCompiler() {
  if (api.__flowBranchCompilerInstalled) return;
  api.__flowBranchCompilerInstalled = true;
  const originalQueuePrompt = api.queuePrompt;
  api.queuePrompt = async function () {
    try {
      const diagnostics = compileFlowPrompt(arguments[1]);
      const warnings = diagnostics.filter((item) => item.level !== "ok");
      if (warnings.length) console.warn("[FlowBranch]", warnings);
    } catch (error) {
      console.error("[FlowBranch] 编译流程失败", error);
    }
    return originalQueuePrompt.apply(this, arguments);
  };
}

app.registerExtension({
  name: "Comfy.FlowBranch",
  init() {
    ensureStyles();
  },
  setup() {
    installPromptCompiler();
  },
  getNodeMenuItems(node) {
    const items = flowNodeMenuItems(node);
    return items.length ? [null, ...items] : [];
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!FLOW_TYPES.has(nodeData.name)) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);
      setupNode(this);
    };
    if (nodeData.name === NODE_TYPES.pipeline) {
      const originalConfigure = nodeType.prototype.configure;
      nodeType.prototype.configure = function () {
        const result = originalConfigure?.apply(this, arguments);
        setupNode(this, true);
        return result;
      };
    }
  },
  loadedGraphNode(node) {
    if (FLOW_TYPES.has(nodeType(node))) setupNode(node, true);
  },
});
