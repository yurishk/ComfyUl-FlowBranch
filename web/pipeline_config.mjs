export const PIPELINE_CONFIG_VERSION = 2;

let idCounter = 0;

function makeId(prefix) {
  idCounter += 1;
  const randomPart = globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    || `${Date.now().toString(36)}${idCounter.toString(36)}`;
  return `${prefix}_${randomPart}`;
}

function cleanId(value, prefix, used) {
  let id = String(value ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "_");
  if (!id || used.has(id)) id = makeId(prefix);
  used.add(id);
  return id;
}

function cleanName(value, fallback) {
  return String(value ?? "").trim() || fallback;
}

function cleanStageName(value, fallback) {
  return value === undefined || value === null ? fallback : String(value).trim();
}

export function createBranch(index = 1) {
  return {
    id: makeId("b"),
    name: `方案 ${index}`,
  };
}

export function createStage(index = 1) {
  return {
    id: makeId("s"),
    name: `阶段 ${index} 结果`,
    enabled: true,
    autoSelect: false,
    selected: null,
    branches: [],
  };
}

export function branchInputName(branchId) {
  const safeId = String(branchId ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
  return `branch_${safeId}`;
}

export function normalizePipelineConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  const rawStages = Array.isArray(source.stages) ? source.stages : [];
  const usedStageIds = new Set();
  const usedBranchIds = new Set();
  const stages = rawStages.map((rawStage, stageIndex) => {
    const stageSource = rawStage && typeof rawStage === "object" ? rawStage : {};
    const stageId = cleanId(stageSource.id, "s", usedStageIds);
    const rawBranches = Array.isArray(stageSource.branches) ? stageSource.branches : [];
    const branches = rawBranches.map((rawBranch, branchIndex) => {
      const branchSource = rawBranch && typeof rawBranch === "object" ? rawBranch : {};
      return {
        id: cleanId(branchSource.id, "b", usedBranchIds),
        name: cleanName(branchSource.name, `方案 ${branchIndex + 1}`),
      };
    });
    const selected = branches.some((item) => item.id === stageSource.selected)
      ? stageSource.selected
      : null;
    return {
      id: stageId,
      name: cleanStageName(stageSource.name, `阶段 ${stageIndex + 1} 结果`),
      enabled: stageSource.enabled !== false,
      autoSelect: stageSource.autoSelect === true,
      selected,
      branches,
    };
  });
  return { version: PIPELINE_CONFIG_VERSION, stages };
}

export function parsePipelineConfig(value) {
  if (typeof value === "string") {
    try {
      return normalizePipelineConfig(JSON.parse(value));
    } catch {
      return normalizePipelineConfig(null);
    }
  }
  return normalizePipelineConfig(value);
}

export function serializePipelineConfig(value) {
  return JSON.stringify(normalizePipelineConfig(value));
}

export const EMPTY_PIPELINE_CONFIG = serializePipelineConfig({ stages: [] });
