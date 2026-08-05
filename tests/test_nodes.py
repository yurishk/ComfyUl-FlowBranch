from comfy_execution.graph_utils import ExecutionBlocker

from flow_branch_nodes import (
    MISSING,
    FlowGet,
    FlowIf,
    FlowPipeline,
    FlowPublish,
    FlowRoute,
    FlowStage,
)


def blocker_message(result):
    assert isinstance(result[0], ExecutionBlocker)
    return result[0].message


def test_publish_without_input_is_a_clear_safety_error_if_compilation_was_skipped():
    assert "没有输入数据" in blocker_message(FlowPublish.publish("g1"))


def test_get_uses_source_then_fallback():
    assert FlowGet.get("g1", fallback="old", source="new") == ("new",)
    assert FlowGet.get("g1", fallback="old") == ("old",)
    assert "找不到发布位置" in blocker_message(FlowGet.get("g1"))


def test_stage_disabled_only_requests_source():
    needed = FlowStage.check_lazy_status("g1", "g2", False, processed=None, source=None)

    assert needed == ["source"]
    assert FlowStage.select("g1", "g2", False, processed="face", source="base") == ("base",)


def test_stage_enabled_requests_processed_and_falls_back_when_unconnected():
    assert FlowStage.check_lazy_status("g1", "g2", True, processed=None, source=None) == ["processed"]
    assert FlowStage.select("g1", "g2", True, processed="face", source="base") == ("face",)
    assert FlowStage.select("g1", "g2", True, processed=MISSING, source="base") == ("base",)


def test_route_only_requests_selected_option():
    needed = FlowRoute.check_lazy_status(
        "g2", "g3", "方案 2", option_1=None, option_2=None, option_3=None, source=None,
    )

    assert needed == ["option_2"]
    assert FlowRoute.select(
        "g2", "g3", "方案 2", option_1="a", option_2="b", option_3="c", source="base",
    ) == ("b",)


def test_route_bypass_and_unconnected_option_use_source():
    assert FlowRoute.check_lazy_status("g2", "g3", "旁路", source=None) == ["source"]
    assert FlowRoute.select("g2", "g3", "旁路", source="base") == ("base",)
    assert FlowRoute.select("g2", "g3", "方案 1", source="base") == ("base",)


def test_if_is_lazy_and_allows_one_missing_branch():
    assert FlowIf.check_lazy_status(True, on_true=None, on_false=None) == ["on_true"]
    assert FlowIf.select(True, on_false="fallback") == ("fallback",)
    assert "两个分支都没有连接" in blocker_message(FlowIf.select(True))


def test_legacy_missing_inputs_remain_clear_safety_errors_if_compilation_was_skipped():
    assert "没有可用数据" in blocker_message(FlowStage.select("g1", "g2", True))
    assert "没有可回退的数据" in blocker_message(FlowRoute.select("g1", "g2", "方案 1"))


def test_compile_error_blocks_without_requesting_expensive_inputs():
    message = "通道存在循环依赖"

    assert FlowStage.check_lazy_status("g1", "g2", True, processed=None, source=None, compile_error=message) == []
    assert message in blocker_message(
        FlowStage.select("g1", "g2", True, processed=MISSING, source=MISSING, compile_error=message)
    )


def test_pipeline_visible_node_requests_only_the_compiled_final_result():
    config = FlowPipeline.EMPTY_CONFIG

    assert FlowPipeline.check_lazy_status(
        "原始图像", "最终图像", config, pipeline_result=None, source=None,
    ) == ["pipeline_result"]
    assert FlowPipeline.select(
        "原始图像", "最终图像", config, pipeline_result="finished", source="original",
    ) == ("finished",)


def test_pipeline_internal_stage_is_lazy_and_bypasses_when_no_plan_is_selected():
    internal = {"__stage_internal": True, "stage_name": "修脸后"}

    assert FlowPipeline.check_lazy_status(
        "原始图像", "修脸后", FlowPipeline.EMPTY_CONFIG,
        selected_value=None, source=None, **internal,
    ) == ["selected_value"]
    assert FlowPipeline.select(
        "原始图像", "修脸后", FlowPipeline.EMPTY_CONFIG,
        selected_value="repaired", source="original", **internal,
    ) == ("repaired",)
    assert FlowPipeline.select(
        "原始图像", "修脸后", FlowPipeline.EMPTY_CONFIG,
        source="original", **internal,
    ) == ("original",)


def test_pipeline_without_compiled_inputs_remains_a_clear_safety_error():
    assert "找不到起点结果" in blocker_message(FlowPipeline.select(
        "原始图像", "最终图像", FlowPipeline.EMPTY_CONFIG,
    ))
    assert "找不到上一阶段结果" in blocker_message(FlowPipeline.select(
        "原始图像", "修脸后", FlowPipeline.EMPTY_CONFIG,
        **{"__stage_internal": True, "stage_name": "修脸后"},
    ))


def test_pipeline_accepts_unlimited_frontend_defined_lazy_inputs():
    optional = FlowPipeline.INPUT_TYPES()["optional"]
    dynamic = optional["branch_any_stable_id"]

    assert "branch_any_stable_id" in optional
    assert dynamic[0] == "*"
    assert dynamic[1]["lazy"] is True
    assert dynamic[1]["forceInput"] is True


def test_pipeline_compile_error_blocks_before_selected_plan_runs():
    message = "方案没有读取上一阶段"

    assert FlowPipeline.check_lazy_status(
        "原始图像", "最终图像", FlowPipeline.EMPTY_CONFIG,
        selected_value=None, source=None, compile_error=message,
        **{"__stage_internal": True},
    ) == []
    assert message in blocker_message(
        FlowPipeline.select(
            "原始图像", "最终图像", FlowPipeline.EMPTY_CONFIG,
            compile_error=message, **{"__stage_internal": True},
        )
    )


def test_public_defaults_use_readable_names_instead_of_g_numbers():
    publish_default = FlowPublish.INPUT_TYPES()["required"]["channel"][1]["default"]
    get_default = FlowGet.INPUT_TYPES()["required"]["channel"][1]["default"]
    pipeline_required = FlowPipeline.INPUT_TYPES()["required"]

    assert publish_default == "Original Image"
    assert get_default == "Original Image"
    assert pipeline_required["input_channel"][1]["default"] == "Original Image"
    assert pipeline_required["output_channel"][1]["default"] == "Final Image"


def test_fixed_legacy_nodes_are_hidden_from_the_new_node_menu():
    for node_class in (FlowStage, FlowRoute, FlowIf):
        assert node_class.DEPRECATED is True
        assert node_class.CATEGORY == "Flow Branch/Legacy"
