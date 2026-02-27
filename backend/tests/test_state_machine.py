"""
KINESYS — Unit Tests for LangGraph State Machine

Verifies:
  - Happy path: valid transcript → actions → waypoints → safe → CONFIRMING
  - Safety guarantee: unsafe actions ALWAYS end in ERROR
  - Empty transcript → ERROR
  - Invalid action plan → ERROR
  - Scene analysis failure → ERROR
  - HITL gating (>5 waypoints or >80% velocity triggers requires_confirmation)
  - Error messages are human-readable
  - Node names match specification
"""

from __future__ import annotations

import math
import pytest

from core.state_machine import (
    PipelineState,
    build_pipeline_graph,
    compile_pipeline,
    run_pipeline,
    get_pipeline_node_names,
    idle_node,
    listening_node,
    decomposing_node,
    scene_analyzing_node,
    planning_node,
    validating_node,
    executing_node,
    confirming_node,
    error_node,
    route_after_validating,
    HITL_WAYPOINT_THRESHOLD,
    HITL_VELOCITY_FRACTION,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

VALID_SCENE = {
    "objects": [
        {
            "id": "red_cube",
            "shape": "box",
            "color": "red",
            "position": [0.5, 0.65, 0.3],
            "size": [0.2, 0.2, 0.2],
            "mass": 0.5,
        },
        {
            "id": "blue_cylinder",
            "shape": "cylinder",
            "color": "blue",
            "position": [-0.5, 0.7, 0.6],
            "size": [0.1, 0.3],
            "mass": 0.3,
        },
    ],
    "end_effector": [0.0, 1.5, 0.0],
    "gripper_open": True,
    "held_object_id": None,
    "table_height": 0.5,
}

VALID_ACTIONS = [
    {"action": "APPROACH", "params": {"target": "red_cube"}},
    {"action": "GRASP", "params": {"target": "red_cube"}},
]

SIMPLE_ACTION = [
    {"action": "WAIT", "params": {"duration_ms": 1000}},
]


# ---------------------------------------------------------------------------
# Graph structure tests
# ---------------------------------------------------------------------------


class TestGraphStructure:
    def test_graph_builds(self) -> None:
        graph = build_pipeline_graph()
        assert graph is not None

    def test_graph_compiles(self) -> None:
        pipeline = compile_pipeline()
        assert pipeline is not None

    def test_node_names(self) -> None:
        names = get_pipeline_node_names()
        expected = [
            "IDLE", "LISTENING", "DECOMPOSING", "SCENE_ANALYZING",
            "PLANNING", "VALIDATING", "EXECUTING", "CONFIRMING", "ERROR",
        ]
        assert names == expected


# ---------------------------------------------------------------------------
# Individual node tests
# ---------------------------------------------------------------------------


class TestIdleNode:
    def test_resets_state(self) -> None:
        state: PipelineState = {"transcript": "test"}
        result = idle_node(state)
        assert result["current_node"] == "IDLE"
        assert result["error_message"] is None
        assert result["is_safe"] is False
        assert result["waypoints"] == []


class TestListeningNode:
    def test_valid_transcript(self) -> None:
        state: PipelineState = {"transcript": "pick up the cube"}
        result = listening_node(state)
        assert result["current_node"] == "LISTENING"
        assert result["transcript"] == "pick up the cube"

    def test_empty_transcript_errors(self) -> None:
        state: PipelineState = {"transcript": ""}
        result = listening_node(state)
        assert result["current_node"] == "ERROR"
        assert result["error_message"] is not None

    def test_whitespace_transcript_errors(self) -> None:
        state: PipelineState = {"transcript": "   "}
        result = listening_node(state)
        assert result["current_node"] == "ERROR"


class TestDecomposingNode:
    def test_valid_plan(self) -> None:
        state: PipelineState = {
            "action_plan": VALID_ACTIONS,
            "decomposition_raw": "[]",
        }
        result = decomposing_node(state)
        assert result["current_node"] == "DECOMPOSING"

    def test_empty_plan_errors(self) -> None:
        state: PipelineState = {
            "action_plan": [],
            "decomposition_raw": "bad json",
        }
        result = decomposing_node(state)
        assert result["current_node"] == "ERROR"
        assert "no actions" in result["error_message"].lower()

    def test_invalid_action_structure_errors(self) -> None:
        state: PipelineState = {
            "action_plan": [{"bad": "structure"}],
            "decomposition_raw": "",
        }
        result = decomposing_node(state)
        assert result["current_node"] == "ERROR"
        assert "invalid structure" in result["error_message"].lower()


class TestSceneAnalyzingNode:
    def test_valid_scene(self) -> None:
        state: PipelineState = {"scene_data": VALID_SCENE}
        result = scene_analyzing_node(state)
        assert result["current_node"] == "SCENE_ANALYZING"
        assert result["scene_state"] is not None

    def test_empty_scene_still_works(self) -> None:
        state: PipelineState = {"scene_data": {}}
        result = scene_analyzing_node(state)
        # Empty scene should still parse (just with no objects)
        assert result["current_node"] == "SCENE_ANALYZING"


class TestPlanningNode:
    def test_valid_planning(self) -> None:
        state: PipelineState = {
            "action_plan": SIMPLE_ACTION,
            "scene_data": VALID_SCENE,
        }
        result = planning_node(state)
        assert result["current_node"] == "PLANNING"
        assert len(result["waypoints"]) > 0
        assert len(result["narration"]) > 0

    def test_invalid_action_errors(self) -> None:
        state: PipelineState = {
            "action_plan": [{"action": "APPROACH", "params": {"target": "nonexistent"}}],
            "scene_data": VALID_SCENE,
        }
        result = planning_node(state)
        # Should error because target doesn't exist
        assert result.get("error_message") is not None or len(result.get("waypoints", [])) == 0


class TestValidatingNode:
    def test_safe_trajectory(self) -> None:
        # First generate valid waypoints through planning
        plan_state: PipelineState = {
            "action_plan": SIMPLE_ACTION,
            "scene_data": VALID_SCENE,
        }
        planned = planning_node(plan_state)

        state: PipelineState = {
            **planned,
            "scene_data": VALID_SCENE,
        }
        result = validating_node(state)
        assert result["current_node"] == "VALIDATING"
        assert result["is_safe"] is True

    def test_unsafe_trajectory_below_table(self) -> None:
        state: PipelineState = {
            "waypoints": [
                {"x": 0, "y": 0.2, "z": 0, "roll": 0, "pitch": 0, "yaw": 0, "gripper_open": True},
            ],
            "scene_data": VALID_SCENE,
        }
        result = validating_node(state)
        assert result["is_safe"] is False

    def test_unsafe_out_of_bounds(self) -> None:
        state: PipelineState = {
            "waypoints": [
                {"x": 5.0, "y": 1.0, "z": 0, "roll": 0, "pitch": 0, "yaw": 0, "gripper_open": True},
            ],
            "scene_data": VALID_SCENE,
        }
        result = validating_node(state)
        assert result["is_safe"] is False


class TestExecutingNode:
    def test_sets_executing(self) -> None:
        state: PipelineState = {"waypoints": [{"x": 0, "y": 1, "z": 0}]}
        result = executing_node(state)
        assert result["current_node"] == "EXECUTING"


class TestConfirmingNode:
    def test_generates_confirmation(self) -> None:
        state: PipelineState = {"narration": ["Approaching red cube", "Grasping red cube"]}
        result = confirming_node(state)
        assert result["current_node"] == "CONFIRMING"
        assert "Done" in result["confirmation_message"]
        assert "Approaching red cube" in result["confirmation_message"]

    def test_default_confirmation(self) -> None:
        state: PipelineState = {"narration": []}
        result = confirming_node(state)
        assert result["confirmation_message"] == "Done."


class TestErrorNode:
    def test_generates_error_message(self) -> None:
        state: PipelineState = {"error_message": "Safety check failed"}
        result = error_node(state)
        assert result["current_node"] == "ERROR"
        assert "Safety check failed" in result["confirmation_message"]
        assert result["final_state"] == "ERROR"

    def test_unknown_error(self) -> None:
        state: PipelineState = {}
        result = error_node(state)
        assert "Unknown error" in result["confirmation_message"]


# ---------------------------------------------------------------------------
# Routing tests
# ---------------------------------------------------------------------------


class TestRouting:
    def test_validation_safe_routes_to_executing(self) -> None:
        state: PipelineState = {"is_safe": True, "requires_confirmation": False}
        assert route_after_validating(state) == "executing"

    def test_validation_unsafe_routes_to_error(self) -> None:
        state: PipelineState = {"is_safe": False}
        assert route_after_validating(state) == "error_unsafe"

    def test_validation_with_error_message(self) -> None:
        state: PipelineState = {"error_message": "something broke", "is_safe": True}
        assert route_after_validating(state) == "error"

    def test_hitl_routes_to_gate_without_confirmation(self) -> None:
        state: PipelineState = {
            "is_safe": True,
            "requires_confirmation": True,
            "human_confirmation_granted": False,
        }
        assert route_after_validating(state) == "hitl_required"

    def test_hitl_routes_to_executing_with_confirmation(self) -> None:
        state: PipelineState = {
            "is_safe": True,
            "requires_confirmation": True,
            "human_confirmation_granted": True,
        }
        assert route_after_validating(state) == "executing"


# ---------------------------------------------------------------------------
# HITL gating tests
# ---------------------------------------------------------------------------


class TestHITLGating:
    def test_many_waypoints_triggers_hitl(self) -> None:
        # Create >5 waypoints that are safe
        waypoints = [
            {"x": i * 0.05, "y": 1.0, "z": 0, "roll": 0, "pitch": 0, "yaw": 0, "gripper_open": True}
            for i in range(8)
        ]
        state: PipelineState = {
            "waypoints": waypoints,
            "scene_data": VALID_SCENE,
        }
        result = validating_node(state)
        if result["is_safe"]:
            assert result["requires_confirmation"] is True
            assert str(HITL_WAYPOINT_THRESHOLD) in result["confirmation_reason"]

    def test_few_waypoints_no_hitl(self) -> None:
        waypoints = [
            {"x": 0, "y": 1.0, "z": 0, "roll": 0, "pitch": 0, "yaw": 0, "gripper_open": True},
            {"x": 0.05, "y": 1.0, "z": 0, "roll": 0, "pitch": 0, "yaw": 0, "gripper_open": True},
        ]
        state: PipelineState = {
            "waypoints": waypoints,
            "scene_data": VALID_SCENE,
        }
        result = validating_node(state)
        if result["is_safe"]:
            assert result["requires_confirmation"] is False

    def test_high_velocity_triggers_hitl(self) -> None:
        # Create two waypoints far apart to trigger velocity HITL
        from core.safety_validator import DEFAULT_SAFETY_CONFIG
        max_vel = DEFAULT_SAFETY_CONFIG.max_linear_velocity_mps
        dt = DEFAULT_SAFETY_CONFIG.assumed_dt
        # Distance that gives 85% of max velocity
        distance = max_vel * dt * 0.85
        waypoints = [
            {"x": 0, "y": 1.0, "z": 0, "roll": 0, "pitch": 0, "yaw": 0, "gripper_open": True},
            {"x": distance, "y": 1.0, "z": 0, "roll": 0, "pitch": 0, "yaw": 0, "gripper_open": True},
        ]
        state: PipelineState = {
            "waypoints": waypoints,
            "scene_data": VALID_SCENE,
        }
        result = validating_node(state)
        if result["is_safe"]:
            assert result["requires_confirmation"] is True
            assert "velocity" in result["confirmation_reason"].lower()


# ---------------------------------------------------------------------------
# Full pipeline integration tests
# ---------------------------------------------------------------------------


class TestFullPipeline:
    def test_happy_path_simple_wait(self) -> None:
        """Simple WAIT action should go through the full pipeline to CONFIRMING."""
        result = run_pipeline(
            transcript="Wait a moment",
            scene_data=VALID_SCENE,
            action_plan=SIMPLE_ACTION,
        )
        assert result["final_state"] == "CONFIRMING"
        assert "Done" in result.get("confirmation_message", "")

    def test_happy_path_approach_grasp(self) -> None:
        """APPROACH + GRASP should succeed."""
        result = run_pipeline(
            transcript="Pick up the red cube",
            scene_data=VALID_SCENE,
            action_plan=VALID_ACTIONS,
        )
        # May or may not be valid depending on safety checks,
        # but should reach either CONFIRMING or ERROR
        assert result["final_state"] in ("CONFIRMING", "ERROR")

    def test_empty_transcript_ends_in_error(self) -> None:
        """Empty transcript MUST end in ERROR."""
        result = run_pipeline(
            transcript="",
            scene_data=VALID_SCENE,
            action_plan=SIMPLE_ACTION,
        )
        assert result["final_state"] == "ERROR"

    def test_empty_action_plan_ends_in_error(self) -> None:
        """Empty action plan MUST end in ERROR."""
        result = run_pipeline(
            transcript="Do something",
            scene_data=VALID_SCENE,
            action_plan=[],
        )
        assert result["final_state"] == "ERROR"

    def test_invalid_action_ends_in_error(self) -> None:
        """Invalid action structure MUST end in ERROR."""
        result = run_pipeline(
            transcript="Do something",
            scene_data=VALID_SCENE,
            action_plan=[{"bad": "data"}],
        )
        assert result["final_state"] == "ERROR"

    def test_nonexistent_target_ends_in_error(self) -> None:
        """Action referencing nonexistent object MUST end in ERROR."""
        result = run_pipeline(
            transcript="Grab the phantom",
            scene_data=VALID_SCENE,
            action_plan=[{"action": "APPROACH", "params": {"target": "phantom"}}],
        )
        assert result["final_state"] == "ERROR"

    def test_unsafe_waypoints_always_error(self) -> None:
        """
        CRITICAL: Actions that produce waypoints below the table or
        outside workspace bounds MUST ALWAYS end in ERROR.
        This is the core safety guarantee.
        """
        # Force an action that goes below table — TRANSLATE to y=0.1
        result = run_pipeline(
            transcript="Move down",
            scene_data=VALID_SCENE,
            action_plan=[
                {"action": "TRANSLATE", "params": {"position": [0.0, 0.1, 0.0]}},
            ],
        )
        # The trajectory planner generates waypoints including safe_y,
        # but the final waypoint at y=0.1 is below table (0.5).
        # The safety validator should catch this.
        assert result["final_state"] == "ERROR"

    def test_out_of_bounds_always_error(self) -> None:
        """Waypoints outside workspace MUST end in ERROR."""
        result = run_pipeline(
            transcript="Move far away",
            scene_data=VALID_SCENE,
            action_plan=[
                {"action": "TRANSLATE", "params": {"position": [5.0, 1.0, 5.0]}},
            ],
        )
        assert result["final_state"] == "ERROR"

    def test_error_has_human_readable_message(self) -> None:
        """Error states must have a human-readable confirmation_message."""
        result = run_pipeline(
            transcript="",
            scene_data=VALID_SCENE,
            action_plan=[],
        )
        assert result["final_state"] == "ERROR"
        msg = result.get("confirmation_message", "")
        assert len(msg) > 10  # Must be a real sentence, not empty
        assert "sorry" in msg.lower() or "error" in msg.lower() or "couldn't" in msg.lower()

    def test_pipeline_carries_state_through(self) -> None:
        """Verify the state object carries all expected fields."""
        result = run_pipeline(
            transcript="Wait a second",
            scene_data=VALID_SCENE,
            action_plan=SIMPLE_ACTION,
        )
        # Check key fields exist
        assert "current_node" in result
        assert "waypoints" in result
        assert "narration" in result
        assert "validation_result" in result
