from __future__ import annotations

import json

from comfy_execution.graph_utils import ExecutionBlocker


class AnyType(str):
    def __ne__(self, other):
        return False


ANY = AnyType("*")
MISSING = object()
CATEGORY = "Flow Branch"
LEGACY_CATEGORY = "Flow Branch/Legacy"


class FlexibleOptionalInputType(dict):
    """Allow frontend-defined lazy inputs while keeping known internal inputs typed."""

    def __init__(self, dynamic_spec, data=None):
        super().__init__(data or {})
        self.dynamic_spec = dynamic_spec

    def __getitem__(self, key):
        return super().__getitem__(key) if dict.__contains__(self, key) else self.dynamic_spec

    def __contains__(self, key):
        return True


def _blocked(message: str):
    return (ExecutionBlocker(f"[Flow Branch] {message}"),)


def _compile_error(error: str):
    return _blocked(error) if error else None


class FlowPublish:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "channel": ("STRING", {
                    "default": "Original Image",
                    "multiline": False,
                    "tooltip": "A unique result name used elsewhere in the workflow.",
                }),
            },
            "optional": {
                "value": (ANY, {"forceInput": True}),
            },
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("value",)
    FUNCTION = "publish"
    CATEGORY = CATEGORY
    DESCRIPTION = "Publish any data under a readable name. It executes only when consumed."

    @classmethod
    def publish(cls, channel: str, value=MISSING):
        if value is MISSING:
            name = channel.strip() or "(empty name)"
            return _blocked(f"Published result '{name}' has no input data. / 发送结果“{name}”没有输入数据。")
        return (value,)


class FlowGet:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "channel": ("STRING", {
                    "default": "Original Image",
                    "multiline": False,
                    "tooltip": "Read a publisher or pipeline stage with the same result name.",
                }),
            },
            "optional": {
                "fallback": (ANY, {"forceInput": True, "lazy": True}),
                "source": (ANY, {"forceInput": True, "lazy": True}),
                "compile_error": ("STRING", {"default": "", "multiline": False}),
            },
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("value",)
    FUNCTION = "get"
    CATEGORY = CATEGORY
    DESCRIPTION = "Read a named result, with an optional fallback when it is unavailable."

    @classmethod
    def check_lazy_status(cls, channel: str, fallback=MISSING, source=MISSING, compile_error: str = ""):
        if compile_error:
            return []
        if source is not MISSING:
            return ["source"] if source is None else []
        if fallback is not MISSING:
            return ["fallback"] if fallback is None else []
        return []

    @classmethod
    def get(cls, channel: str, fallback=MISSING, source=MISSING, compile_error: str = ""):
        error = _compile_error(compile_error)
        if error:
            return error
        if source is not MISSING:
            return (source,)
        if fallback is not MISSING:
            return (fallback,)
        name = channel.strip() or "(empty name)"
        return _blocked(
            f"Result '{name}' has no publisher or fallback. / "
            f"读取结果“{name}”找不到发布位置，也没有连接回退输入。"
        )


class FlowPipeline:
    EMPTY_CONFIG = json.dumps({"version": 2, "stages": []}, ensure_ascii=False, separators=(",", ":"))

    @classmethod
    def INPUT_TYPES(cls):
        known_optional = {
            "source": (ANY, {"forceInput": True, "lazy": True}),
            "pipeline_result": (ANY, {"forceInput": True, "lazy": True}),
            "selected_value": (ANY, {"forceInput": True, "lazy": True}),
            "compile_error": ("STRING", {"default": "", "multiline": False}),
            "stage_name": ("STRING", {"default": "", "multiline": False}),
            "selected_name": ("STRING", {"default": "", "multiline": False}),
            "__stage_internal": ("BOOLEAN", {"default": False}),
            "__flow_generated": ("BOOLEAN", {"default": False}),
        }
        return {
            "required": {
                "input_channel": ("STRING", {
                    "default": "Original Image",
                    "multiline": False,
                    "tooltip": "Result name read by the first stage.",
                }),
                "output_channel": ("STRING", {
                    "default": "Final Image",
                    "multiline": False,
                    "tooltip": "Result name published when the pipeline finishes.",
                }),
                "pipeline_config": ("STRING", {
                    "default": cls.EMPTY_CONFIG,
                    "multiline": False,
                }),
            },
            "optional": FlexibleOptionalInputType(
                (ANY, {"forceInput": True, "lazy": True}),
                known_optional,
            ),
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("pipeline_result",)
    FUNCTION = "select"
    CATEGORY = CATEGORY
    DESCRIPTION = "A lazy orchestrator with unlimited stages and options."

    @classmethod
    def check_lazy_status(cls, input_channel: str, output_channel: str, pipeline_config: str,
                          source=MISSING, pipeline_result=MISSING, selected_value=MISSING,
                          compile_error: str = "", **kwargs):
        if compile_error:
            return []
        if kwargs.get("__stage_internal", False):
            if selected_value is not MISSING:
                return ["selected_value"] if selected_value is None else []
            if source is not MISSING:
                return ["source"] if source is None else []
            return []
        if pipeline_result is not MISSING:
            return ["pipeline_result"] if pipeline_result is None else []
        if source is not MISSING:
            return ["source"] if source is None else []
        return []

    @classmethod
    def select(cls, input_channel: str, output_channel: str, pipeline_config: str,
               source=MISSING, pipeline_result=MISSING, selected_value=MISSING,
               compile_error: str = "", **kwargs):
        error = _compile_error(compile_error)
        if error:
            return error
        if kwargs.get("__stage_internal", False):
            if selected_value is not MISSING:
                return (selected_value,)
            if source is not MISSING:
                return (source,)
            stage_name = kwargs.get("stage_name") or output_channel or "unnamed stage"
            return _blocked(
                f"Stage '{stage_name}' cannot find its previous result. / "
                f"阶段“{stage_name}”找不到上一阶段结果。"
            )
        if pipeline_result is not MISSING:
            return (pipeline_result,)
        if source is not MISSING:
            return (source,)
        name = input_channel.strip() or "(empty name)"
        return _blocked(f"Pipeline cannot find starting result '{name}'. / 流程找不到起点结果“{name}”。")


class FlowStage:
    DEPRECATED = True
    CATEGORY = LEGACY_CATEGORY
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_channel": ("STRING", {
                    "default": "上一阶段",
                    "multiline": False,
                    "tooltip": "上一步成功结果的通道。",
                }),
                "output_channel": ("STRING", {
                    "default": "本阶段",
                    "multiline": False,
                    "tooltip": "本阶段结果发布到这个通道。",
                }),
                "enabled": ("BOOLEAN", {
                    "default": True,
                    "label_on": "启用",
                    "label_off": "旁路",
                }),
            },
            "optional": {
                "processed": (ANY, {"forceInput": True, "lazy": True}),
                "source": (ANY, {"forceInput": True, "lazy": True}),
                "compile_error": ("STRING", {"default": "", "multiline": False}),
            },
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("阶段结果",)
    FUNCTION = "select"
    CATEGORY = LEGACY_CATEGORY
    DESCRIPTION = "启用时采用处理结果，关闭或处理结果未连接时传递上一步，并发布输出通道。"

    @classmethod
    def check_lazy_status(cls, input_channel: str, output_channel: str, enabled: bool,
                          processed=MISSING, source=MISSING, compile_error: str = ""):
        if compile_error:
            return []
        if enabled and processed is not MISSING:
            return ["processed"] if processed is None else []
        if source is not MISSING:
            return ["source"] if source is None else []
        return []

    @classmethod
    def select(cls, input_channel: str, output_channel: str, enabled: bool,
               processed=MISSING, source=MISSING, compile_error: str = ""):
        error = _compile_error(compile_error)
        if error:
            return error
        if enabled and processed is not MISSING:
            return (processed,)
        if source is not MISSING:
            return (source,)
        state = "启用但处理结果未连接" if enabled else "处于旁路状态"
        return _blocked(
            f"阶段“{input_channel} → {output_channel}”{state}，但输入通道“{input_channel}”没有可用数据。"
        )


class FlowRoute:
    DEPRECATED = True
    CATEGORY = LEGACY_CATEGORY
    ROUTES = ("旁路", "方案 1", "方案 2", "方案 3")
    OPTION_NAMES = {
        "方案 1": "option_1",
        "方案 2": "option_2",
        "方案 3": "option_3",
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_channel": ("STRING", {
                    "default": "上一阶段",
                    "multiline": False,
                    "tooltip": "旁路或方案缺失时使用的上一步通道。",
                }),
                "output_channel": ("STRING", {
                    "default": "本阶段",
                    "multiline": False,
                    "tooltip": "最终选择结果发布到这个通道。",
                }),
                "route": (cls.ROUTES, {"default": "旁路"}),
            },
            "optional": {
                "option_1": (ANY, {"forceInput": True, "lazy": True}),
                "option_2": (ANY, {"forceInput": True, "lazy": True}),
                "option_3": (ANY, {"forceInput": True, "lazy": True}),
                "source": (ANY, {"forceInput": True, "lazy": True}),
                "compile_error": ("STRING", {"default": "", "multiline": False}),
            },
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("选择结果",)
    FUNCTION = "select"
    CATEGORY = LEGACY_CATEGORY
    DESCRIPTION = "仅执行选中的方案；旁路或所选方案未连接时返回输入通道，并发布输出通道。"

    @classmethod
    def check_lazy_status(cls, input_channel: str, output_channel: str, route: str,
                          option_1=MISSING, option_2=MISSING, option_3=MISSING,
                          source=MISSING, compile_error: str = ""):
        if compile_error:
            return []
        option_name = cls.OPTION_NAMES.get(route)
        options = {
            "option_1": option_1,
            "option_2": option_2,
            "option_3": option_3,
        }
        option_value = options.get(option_name, MISSING)
        if option_name and option_value is not MISSING:
            return [option_name] if option_value is None else []
        if source is not MISSING:
            return ["source"] if source is None else []
        return []

    @classmethod
    def select(cls, input_channel: str, output_channel: str, route: str,
               option_1=MISSING, option_2=MISSING, option_3=MISSING,
               source=MISSING, compile_error: str = ""):
        error = _compile_error(compile_error)
        if error:
            return error
        options = {"方案 1": option_1, "方案 2": option_2, "方案 3": option_3}
        selected = options.get(route, MISSING)
        if selected is not MISSING:
            return (selected,)
        if source is not MISSING:
            return (source,)
        return _blocked(
            f"多路方案“{input_channel} → {output_channel}”无法使用“{route}”，"
            f"且输入通道“{input_channel}”没有可回退的数据。"
        )


class FlowIf:
    DEPRECATED = True
    CATEGORY = LEGACY_CATEGORY
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "condition": ("BOOLEAN", {
                    "default": True,
                    "label_on": "真",
                    "label_off": "假",
                }),
            },
            "optional": {
                "on_true": (ANY, {"forceInput": True, "lazy": True}),
                "on_false": (ANY, {"forceInput": True, "lazy": True}),
            },
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("选择结果",)
    FUNCTION = "select"
    CATEGORY = LEGACY_CATEGORY
    DESCRIPTION = "惰性布尔分支；只执行选中分支，选中分支未连接时自动使用另一分支。"

    @classmethod
    def check_lazy_status(cls, condition: bool, on_true=MISSING, on_false=MISSING):
        primary_name, primary = ("on_true", on_true) if condition else ("on_false", on_false)
        fallback_name, fallback = ("on_false", on_false) if condition else ("on_true", on_true)
        if primary is not MISSING:
            return [primary_name] if primary is None else []
        if fallback is not MISSING:
            return [fallback_name] if fallback is None else []
        return []

    @classmethod
    def select(cls, condition: bool, on_true=MISSING, on_false=MISSING):
        primary = on_true if condition else on_false
        fallback = on_false if condition else on_true
        if primary is not MISSING:
            return (primary,)
        if fallback is not MISSING:
            return (fallback,)
        return _blocked("条件选择的两个分支都没有连接。")


NODE_CLASS_MAPPINGS = {
    "FlowBranchPublish": FlowPublish,
    "FlowBranchGet": FlowGet,
    "FlowBranchPipeline": FlowPipeline,
    "FlowBranchStage": FlowStage,
    "FlowBranchRoute": FlowRoute,
    "FlowBranchIf": FlowIf,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "FlowBranchPublish": "Publish Result",
    "FlowBranchGet": "Read Result",
    "FlowBranchPipeline": "Flow Orchestrator",
    "FlowBranchStage": "[Legacy] Stage Switch",
    "FlowBranchRoute": "[Legacy] Multi-route",
    "FlowBranchIf": "[Legacy] Conditional Select",
}
