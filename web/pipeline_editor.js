import {
  branchInputName,
  createBranch,
  createStage,
  parsePipelineConfig,
  serializePipelineConfig,
} from "./pipeline_config.mjs";
import { tr } from "./i18n.mjs";

let editorCounter = 0;
export const PIPELINE_NODE_MIN_WIDTH = 430;
const PIPELINE_WIDGET_START_Y = 4;
const PIPELINE_NODE_BOTTOM_PADDING = 8;

export function calculateStackContentHeight(
  childHeights,
  gap = 0,
  paddingTop = 0,
  paddingBottom = 0,
) {
  const heights = childHeights.filter((height) => Number.isFinite(height) && height > 0);
  return Math.ceil(
    heights.reduce((total, height) => total + height, 0)
      + gap * Math.max(heights.length - 1, 0)
      + paddingTop
      + paddingBottom,
  );
}

export function calculateSlotCanvasY(widgetY, rowOffsetY, widgetMargin = 0) {
  return widgetY + rowOffsetY + widgetMargin;
}

function stackContentHeight(root) {
  const style = getComputedStyle(root);
  const gap = Number.parseFloat(style.rowGap || style.gap) || 0;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  return calculateStackContentHeight(
    [...root.children].map((child) => child.offsetHeight),
    gap,
    paddingTop,
    paddingBottom,
  );
}

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function iconButton(symbol, title, onClick) {
  const button = element("button", "fb-icon-button", symbol);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", onClick);
  return button;
}

function nodeInput(node, name) {
  return node.inputs?.find((item) => item.name === name);
}

function isConnected(input) {
  return input?.link !== null && input?.link !== undefined;
}

function removeInputByName(node, name) {
  const index = node.inputs?.findIndex((item) => item.name === name) ?? -1;
  if (index >= 0) node.removeInput(index);
}

function stopCanvasGestures(root) {
  for (const eventName of ["pointerdown", "mousedown", "wheel"]) {
    root.addEventListener(eventName, (event) => event.stopPropagation());
  }
}

export function setupPipelineEditor(node, app, onStateChanged) {
  if (node.__flowPipelineEditor) return node.__flowPipelineEditor;
  const configWidget = node.widgets?.find((item) => item.name === "pipeline_config");
  if (!configWidget) return null;

  editorCounter += 1;
  const editorId = `flow-pipeline-${editorCounter}`;
  const root = element("div", "fb-pipeline-editor");
  stopCanvasGestures(root);
  let config = parsePipelineConfig(configWidget.value);
  let rowElements = new Map();
  let destroyed = false;
  let syncingInputs = false;
  let fittingNode = false;

  // Branch sockets are positioned beside DOM rows. A fixed widget origin keeps
  // LiteGraph's slot bounds from pushing the widget down again on every frame.
  node.widgets_start_y = PIPELINE_WIDGET_START_Y;

  function desiredEditorHeight() {
    return Math.max(52, stackContentHeight(root) + 8);
  }

  const domWidget = node.addDOMWidget("flow_pipeline_editor", "flow-pipeline-editor", root, {
    serialize: false,
    getMinHeight() {
      return desiredEditorHeight();
    },
    getMaxHeight() {
      return desiredEditorHeight();
    },
  });
  domWidget.serialize = false;

  function persist() {
    configWidget.value = serializePipelineConfig(config);
  }

  function desiredBranchInputs() {
    return config.stages.flatMap((stage) => stage.branches.map((branch) => ({
      name: branchInputName(branch.id),
      label: branch.name,
    })));
  }

  function syncInputs() {
    syncingInputs = true;
    try {
      const desired = desiredBranchInputs();
      const desiredNames = new Set(desired.map((item) => item.name));
      const obsolete = (node.inputs || [])
        .filter((item) => item.name.startsWith("branch_") && !desiredNames.has(item.name))
        .map((item) => item.name);
      for (const name of obsolete) removeInputByName(node, name);
      for (const item of desired) {
        let input = nodeInput(node, item.name);
        if (!input) input = node.addInput(item.name, "*");
        input.label = " ";
        input.localized_name = " ";
        input.__flowBranchLabel = item.label;
      }
    } finally {
      syncingInputs = false;
    }
  }

  function updateSlotOffsets() {
    if (destroyed || !root.isConnected) return;
    const rootRect = root.getBoundingClientRect();
    const scale = root.offsetHeight > 0 ? rootRect.height / root.offsetHeight : 1;
    for (const [inputName, row] of rowElements) {
      const input = nodeInput(node, inputName);
      if (!input || !row.isConnected) continue;
      const rowRect = row.getBoundingClientRect();
      input.__flowBranchOffsetY = (rowRect.top - rootRect.top + rowRect.height / 2) / (scale || 1);
    }
    updateCanvasPositions();
  }

  function updateCanvasPositions() {
    for (const input of node.inputs || []) {
      if (!input.name.startsWith("branch_") || input.__flowBranchOffsetY === undefined) continue;
      input.pos = [
        0,
        calculateSlotCanvasY(domWidget.y, input.__flowBranchOffsetY, domWidget.margin),
      ];
    }
  }

  function fitNode() {
    if (destroyed || fittingNode) return;
    fittingNode = true;
    try {
      const width = Math.max(PIPELINE_NODE_MIN_WIDTH, node.size?.[0] || 0);
      const height = Math.max(
        150,
        PIPELINE_WIDGET_START_Y + desiredEditorHeight() + PIPELINE_NODE_BOTTOM_PADDING,
      );
      if (Math.abs((node.size?.[1] || 0) - height) > 2 || (node.size?.[0] || 0) < width) {
        node.setSize([width, height]);
      }
      updateSlotOffsets();
      app.graph?.setDirtyCanvas(true, true);
    } finally {
      fittingNode = false;
    }
  }

  function notify({ render = true } = {}) {
    persist();
    syncInputs();
    if (render) renderEditor();
    onStateChanged?.();
    requestAnimationFrame(fitNode);
  }

  function makeStageHeader(stage, stageIndex, previousName) {
    const header = element("div", "fb-stage-header");
    const enabled = element("input", "fb-stage-toggle");
    enabled.type = "checkbox";
    enabled.checked = stage.enabled;
    enabled.title = stage.enabled ? tr("阶段已启用", "Stage enabled") : tr("阶段已旁路", "Stage bypassed");
    enabled.addEventListener("change", () => {
      stage.enabled = enabled.checked;
      notify();
    });

    const names = element("div", "fb-stage-names");
    const source = element("div", "fb-stage-source");
    source.append(
      element("span", "fb-stage-index", tr(`阶段 ${stageIndex + 1}`, `Stage ${stageIndex + 1}`)),
      element("span", "fb-stage-path", `${tr("来自", "From")} ${previousName || tr("未命名结果", "Unnamed result")}`),
    );
    const name = element("input", "fb-name-input");
    name.type = "text";
    name.value = stage.name;
    name.placeholder = tr("阶段结果名称", "Stage result name");
    name.title = tr("该阶段完成后发布的结果名称", "Result name published by this stage");
    name.addEventListener("input", () => {
      stage.name = name.value;
      persist();
      onStateChanged?.();
    });
    name.addEventListener("change", () => notify());
    names.append(source, name);

    const actions = element("div", "fb-stage-actions");
    const moveUp = iconButton("↑", tr("阶段上移", "Move stage up"), () => {
      [config.stages[stageIndex - 1], config.stages[stageIndex]] = [
        config.stages[stageIndex], config.stages[stageIndex - 1],
      ];
      notify();
    });
    moveUp.disabled = stageIndex <= 0;
    const moveDown = iconButton("↓", tr("阶段下移", "Move stage down"), () => {
      [config.stages[stageIndex + 1], config.stages[stageIndex]] = [
        config.stages[stageIndex], config.stages[stageIndex + 1],
      ];
      notify();
    });
    moveDown.disabled = stageIndex >= config.stages.length - 1;
    const removeStage = iconButton("×", tr("删除阶段", "Delete stage"), () => {
      config.stages.splice(stageIndex, 1);
      notify();
    });
    removeStage.classList.add("fb-delete-button");
    actions.append(moveUp, moveDown, removeStage);
    header.append(enabled, names, actions);
    return header;
  }

  function makeBypassRow(stage) {
    const label = element("label", "fb-branch-row fb-bypass-row");
    if (!stage.autoSelect && stage.selected === null) label.classList.add("fb-branch-selected");
    const radio = element("input", "fb-branch-radio");
    radio.type = "radio";
    radio.name = `${editorId}-${stage.id}`;
    radio.checked = stage.selected === null;
    radio.disabled = !stage.enabled || stage.autoSelect;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      stage.selected = null;
      notify();
    });
    label.title = tr("不执行本阶段，直接使用上一阶段结果", "Skip this stage and use the previous result");
    label.append(radio, element("span", "fb-bypass-label", tr("跳过本阶段", "Bypass this stage")));
    return label;
  }

  function makeAutoSelectRow(stage) {
    const label = element("label", "fb-auto-row");
    if (stage.autoSelect) label.classList.add("fb-auto-enabled");
    const toggle = element("input", "fb-auto-toggle");
    toggle.type = "checkbox";
    toggle.checked = stage.autoSelect;
    toggle.title = tr("运行时按从上到下的顺序选择第一个可用方案", "At runtime, select the first available option from top to bottom");
    toggle.addEventListener("change", () => {
      stage.autoSelect = toggle.checked;
      notify();
    });
    label.append(
      toggle,
      element("span", "fb-auto-label", tr("自动选择可用方案", "Auto-select available option")),
      element("span", "fb-auto-hint", tr("从上到下", "Top to bottom")),
    );
    return label;
  }

  function makeBranchRow(stage, branch, branchIndex) {
    const inputName = branchInputName(branch.id);
    const row = element("div", "fb-branch-row");
    row.dataset.inputName = inputName;
    if (!stage.autoSelect && stage.selected === branch.id) row.classList.add("fb-branch-selected");
    if (isConnected(nodeInput(node, inputName))) row.classList.add("fb-branch-connected");

    const radio = element("input", "fb-branch-radio");
    radio.type = "radio";
    radio.name = `${editorId}-${stage.id}`;
    radio.checked = stage.selected === branch.id;
    radio.disabled = !stage.enabled || stage.autoSelect;
    radio.title = tr("选择这个方案", "Select this option");
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      stage.selected = branch.id;
      notify();
    });

    const name = element("input", "fb-name-input fb-branch-name");
    name.type = "text";
    name.value = branch.name;
    name.placeholder = tr(`方案 ${branchIndex + 1}`, `Option ${branchIndex + 1}`);
    name.title = tr("方案名称", "Option name");
    name.addEventListener("input", () => {
      branch.name = name.value;
      const input = nodeInput(node, inputName);
      if (input) input.__flowBranchLabel = branch.name;
      persist();
    });
    name.addEventListener("change", () => notify());

    const connected = isConnected(nodeInput(node, inputName));
    const status = element(
      "span",
      `fb-connection-status ${connected ? "fb-is-connected" : "fb-is-unconnected"}`,
      connected ? tr("已连接", "Connected") : tr("未连接", "Not connected"),
    );
    status.title = connected
      ? tr("方案结果已连接", "Option result connected")
      : tr("方案结果未连接，将沿用上一阶段", "Not connected; the previous stage result will be used");

    const remove = iconButton("×", tr("删除方案", "Delete option"), () => {
      stage.branches.splice(branchIndex, 1);
      if (stage.selected === branch.id) stage.selected = null;
      notify();
    });
    remove.classList.add("fb-delete-button");
    row.append(radio, name, status, remove);
    rowElements.set(inputName, row);
    return row;
  }

  function makeStage(stage, stageIndex, previousName) {
    const section = element("section", "fb-stage");
    if (!stage.enabled) section.classList.add("fb-stage-disabled");
    if (stage.autoSelect) section.classList.add("fb-stage-auto");
    section.append(
      makeStageHeader(stage, stageIndex, previousName),
      makeAutoSelectRow(stage),
      makeBypassRow(stage),
    );
    for (const [branchIndex, branch] of stage.branches.entries()) {
      section.append(makeBranchRow(stage, branch, branchIndex));
    }
    const addBranch = element("button", "fb-add-button fb-add-branch", tr("+ 添加方案", "+ Add option"));
    addBranch.type = "button";
    addBranch.addEventListener("click", () => {
      const branch = createBranch(stage.branches.length + 1);
      stage.branches.push(branch);
      stage.selected = branch.id;
      notify();
    });
    section.append(addBranch);
    return section;
  }

  function renderEditor() {
    rowElements = new Map();
    root.replaceChildren();
    if (config.stages.length === 0) {
      root.append(element("div", "fb-empty-state", tr("尚未添加处理阶段", "No processing stages yet")));
    }
    let previousName = node.widgets?.find((item) => item.name === "input_channel")?.value
      || tr("原始图像", "Original Image");
    for (const [stageIndex, stage] of config.stages.entries()) {
      root.append(makeStage(stage, stageIndex, previousName));
      previousName = stage.name;
    }
    const addStage = element("button", "fb-add-button fb-add-stage", tr("+ 添加阶段", "+ Add stage"));
    addStage.type = "button";
    addStage.addEventListener("click", () => {
      const stage = createStage(config.stages.length + 1);
      const branch = createBranch(1);
      stage.branches.push(branch);
      stage.selected = branch.id;
      config.stages.push(stage);
      notify();
    });
    root.append(addStage);
    requestAnimationFrame(fitNode);
  }

  const observer = new ResizeObserver(() => requestAnimationFrame(updateSlotOffsets));
  observer.observe(root);

  const editor = {
    get config() {
      return config;
    },
    persist,
    render: renderEditor,
    reload() {
      config = parsePipelineConfig(configWidget.value);
      syncInputs();
      renderEditor();
    },
    refreshConnections() {
      if (syncingInputs) return;
      renderEditor();
    },
    updateCanvasPositions,
    destroy() {
      destroyed = true;
      observer.disconnect();
    },
  };
  node.__flowPipelineEditor = editor;
  syncInputs();
  renderEditor();
  return editor;
}
