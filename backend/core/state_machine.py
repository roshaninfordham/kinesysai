"""
KINESYS — LangGraph State Machine

Defines a stateful workflow with mandatory validation gates and error recovery:

  IDLE → LISTENING → DECOMPOSING → SCENE_ANALYZING → PLANNING
       → VALIDATING → (HITL check) → EXECUTING → CONFIRMING → IDLE
                    ↘ ERROR → IDLE

Safety guarantee: VALIDATING → EXECUTING transition ONLY occurs if ALL
constraints pass. Any failure routes to ERROR with human-readable explanation.

Human-in-the-loop gate: sequences with >5 waypoints or velocities >80% of
max require explicit confirmation before execution.
"""

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, TypedDict

from langgraph.graph import StateGraph, END

from ai.llm_client import LLMClient
from ai.task_decomposer import decompose_command
from ai.scene_analyzer import scene_state_from_frontend, analyze_scene
from core.action_primitives import SceneState, Waypoint
from core.trajectory_planner import plan_trajectory, TrajectoryPlan
from core.safety_validator import (
    SafetyConfig,
    SafetyValidationResult,
    validate_trajectory,
    DEFAULT_SAFETY_CONFIG,
)

logger = logging.getLogger("kinesys.state_machine")

# ---------------------------------------------------------------------------
# State schema (TypedDict for LangGraph)
# ---------------------------------------------------------------------------


class PipelineState(TypedDict, total=False):
    """Full state carried through the LangGraph pipeline."""

    # Pipeline metadata
    current_node: str
    error_message: Optional[str]

    # Input
    transcript: str
    scene_data: Dict[str, Any]

    # Intermediate
    scene_state: Optional[Dict[str, Any]]
    action_plan: List[Dict[str, Any]]
    decomposition_raw: str
    confidence_scores: Dict[str, float]

    # Planning
    trajectory_plan: Optional[Dict[str, Any]]
    waypoints: List[Dict[str, Any]]
    narration: List[str]

    # Validation
    validation_result: Optional[Dict[str, Any]]
    is_safe: bool
    requires_confirmation: bool
    confirmation_reason: str
    human_confirmation_granted: bool

    # Flow control
    resume_from_idle: bool

    # Output
    confirmation_message: str
    final_state: str


# ---------------------------------------------------------------------------
# HITL thresholds
# ---------------------------------------------------------------------------

HITL_WAYPOINT_THRESHOLD = 5
HITL_VELOCITY_FRACTION = 0.8  # 80% of max


# ---------------------------------------------------------------------------
# Node functions
# ---------------------------------------------------------------------------


def idle_node(state: PipelineState) -> PipelineState:
    """Entry / reset node."""
    return {
        **state,
        "current_node": "IDLE",
        "error_message": None,
        # Preserve precomputed decomposition output if provided by caller.
        "action_plan": state.get("action_plan", []),
        "waypoints": [],
        "narration": [],
        "is_safe": False,
        "requires_confirmation": False,
        "confirmation_reason": "",
        # Preserve terminal state set by ERROR/CONFIRMING when returning via IDLE.
        "final_state": state.get("final_state", "IDLE"),
        "resume_from_idle": state.get("resume_from_idle", True),
    }


def listening_node(state: PipelineState) -> PipelineState:
    """Receives transcript from user. In practice this is the entry data."""
    transcript = state.get("transcript", "")
    if not transcript or not transcript.strip():
        return {
            **state,
            "current_node": "ERROR",
            "error_message": "No speech transcript received",
            "final_state": "ERROR",
        }
    return {
        **state,
        "current_node": "LISTENING",
        "transcript": transcript.strip(),
    }


def decomposing_node(state: PipelineState) -> PipelineState:
    """
    Call the LLM to decompose the transcript into action primitives.
    NOTE: This is a synchronous wrapper. The actual async LLM call is handled
    by running the graph in an async context or via pre-computed results.
    For LangGraph compatibility, we accept pre-computed decomposition results
    passed through the state, or mark for async processing.
    """
    # If action_plan was pre-populated (async path), validate it
    action_plan = state.get("action_plan", [])
    decomp_raw = state.get("decomposition_raw", "")

    if not action_plan:
        return {
            **state,
            "current_node": "ERROR",
            "error_message": "LLM decomposition returned no actions. Raw: " + decomp_raw[:200],
            "final_state": "ERROR",
        }

    # Validate all actions have required structure
    for i, action in enumerate(action_plan):
        if not isinstance(action, dict) or "action" not in action:
            return {
                **state,
                "current_node": "ERROR",
                "error_message": f"Action {i} has invalid structure: {action}",
                "final_state": "ERROR",
            }

    logger.info("Decomposed transcript into %d actions", len(action_plan))

    return {
        **state,
        "current_node": "DECOMPOSING",
    }


def scene_analyzing_node(state: PipelineState) -> PipelineState:
    """Parse and analyze the scene from frontend data."""
    scene_data = state.get("scene_data", {})

    try:
        scene = scene_state_from_frontend(scene_data)
        graph = analyze_scene(scene)
        scene_dict: Dict[str, Any] = graph.to_dict()
    except Exception as exc:
        logger.error("Scene analysis failed: %s", exc)
        return {
            **state,
            "current_node": "ERROR",
            "error_message": f"Scene analysis failed: {exc}",
            "final_state": "ERROR",
        }

    return {
        **state,
        "current_node": "SCENE_ANALYZING",
        "scene_state": scene_dict,
    }


def planning_node(state: PipelineState) -> PipelineState:
    """Run trajectory planner to convert actions into waypoints."""
    action_plan = state.get("action_plan", [])
    scene_data = state.get("scene_data", {})

    try:
        scene = scene_state_from_frontend(scene_data)
        plan: TrajectoryPlan = plan_trajectory(action_plan, scene)
    except Exception as exc:
        logger.error("Trajectory planning failed: %s", exc)
        return {
            **state,
            "current_node": "ERROR",
            "error_message": f"Planning failed: {exc}",
            "final_state": "ERROR",
        }

    waypoints_list = [
        {
            "x": wp.x, "y": wp.y, "z": wp.z,
            "roll": wp.roll, "pitch": wp.pitch, "yaw": wp.yaw,
            "gripper_open": wp.gripper_open,
        }
        for wp in plan.all_waypoints
    ]

    return {
        **state,
        "current_node": "PLANNING",
        "trajectory_plan": plan.to_dict(),
        "waypoints": waypoints_list,
        "narration": plan.narration_sequence,
    }


def validating_node(state: PipelineState) -> PipelineState:
    """
    Run safety validation on the full waypoint sequence.
    Also determine if human-in-the-loop confirmation is required.
    """
    scene_data = state.get("scene_data", {})
    traj_plan = state.get("trajectory_plan", {})

    # Reconstruct Waypoint objects for the validator
    raw_waypoints = state.get("waypoints", [])
    waypoints = [
        Waypoint(
            x=wp["x"], y=wp["y"], z=wp["z"],
            roll=wp.get("roll", 0), pitch=wp.get("pitch", 0), yaw=wp.get("yaw", 0),
            gripper_open=wp.get("gripper_open", True),
        )
        for wp in raw_waypoints
    ]

    try:
        scene = scene_state_from_frontend(scene_data)
        safety: SafetyValidationResult = validate_trajectory(waypoints, scene)
    except Exception as exc:
        logger.error("Validation failed: %s", exc)
        return {
            **state,
            "current_node": "ERROR",
            "error_message": f"Validation error: {exc}",
            "final_state": "ERROR",
            "is_safe": False,
        }

    validation_dict = safety.to_dict()

    # Check HITL conditions
    requires_hitl = False
    hitl_reason = ""

    # Condition 1: >5 waypoints
    if len(waypoints) > HITL_WAYPOINT_THRESHOLD:
        requires_hitl = True
        hitl_reason = f"Trajectory has {len(waypoints)} waypoints (threshold: {HITL_WAYPOINT_THRESHOLD})"

    # Condition 2: velocity >80% of max
    config = DEFAULT_SAFETY_CONFIG
    max_vel = config.max_linear_velocity_mps
    dt = config.assumed_dt
    for i in range(1, len(waypoints)):
        prev, curr = waypoints[i - 1], waypoints[i]
        dx = curr.x - prev.x
        dy = curr.y - prev.y
        dz = curr.z - prev.z
        dist = math.sqrt(dx * dx + dy * dy + dz * dz)
        vel = dist / dt
        if vel > max_vel * HITL_VELOCITY_FRACTION:
            requires_hitl = True
            hitl_reason = (
                f"Waypoint {i} velocity {vel:.2f} m/s exceeds "
                f"{HITL_VELOCITY_FRACTION * 100:.0f}% of max ({max_vel} m/s)"
            )
            break

    human_confirmed = state.get("human_confirmation_granted", False)

    error_message = state.get("error_message")
    if requires_hitl and not human_confirmed:
        error_message = (
            "Human confirmation required before execution: "
            + (hitl_reason or "trajectory flagged for review")
        )

    return {
        **state,
        "current_node": "VALIDATING",
        "validation_result": validation_dict,
        "is_safe": safety.is_safe,
        "requires_confirmation": requires_hitl,
        "confirmation_reason": hitl_reason,
        "human_confirmation_granted": human_confirmed,
        "error_message": error_message,
    }


def executing_node(state: PipelineState) -> PipelineState:
    """Mark trajectory as ready for execution (frontend handles actual motion)."""
    narration = state.get("narration", [])
    logger.info("Executing %d waypoints", len(state.get("waypoints", [])))

    return {
        **state,
        "current_node": "EXECUTING",
    }


def confirming_node(state: PipelineState) -> PipelineState:
    """Generate confirmation message after successful execution."""
    narration = state.get("narration", [])

    if narration:
        confirmation = "Done. " + ". ".join(narration) + "."
    else:
        confirmation = "Done."

    return {
        **state,
        "current_node": "CONFIRMING",
        "confirmation_message": confirmation,
        "final_state": "CONFIRMING",
        "resume_from_idle": False,
    }


def error_node(state: PipelineState) -> PipelineState:
    """Generate human-readable error explanation and prepare for recovery."""
    error = state.get("error_message", "Unknown error")
    logger.warning("Pipeline error: %s", error)

    return {
        **state,
        "current_node": "ERROR",
        "confirmation_message": f"Sorry, I couldn't do that. {error}",
        "final_state": "ERROR",
        "resume_from_idle": False,
    }


def route_after_idle(state: PipelineState) -> str:
    """Route after IDLE: either begin processing or terminate."""
    if state.get("resume_from_idle", True):
        return "listening"
    return "end"


# ---------------------------------------------------------------------------
# Routing functions (conditional edges)
# ---------------------------------------------------------------------------


def route_after_listening(state: PipelineState) -> str:
    """Route after LISTENING: go to DECOMPOSING or ERROR."""
    if state.get("error_message"):
        return "error"
    return "decomposing"


def route_after_decomposing(state: PipelineState) -> str:
    """Route after DECOMPOSING: ERROR if invalid, else SCENE_ANALYZING."""
    if state.get("error_message"):
        return "error"
    if not state.get("action_plan"):
        return "error"
    return "scene_analyzing"


def route_after_scene(state: PipelineState) -> str:
    """Route after SCENE_ANALYZING: ERROR if failed, else PLANNING."""
    if state.get("error_message"):
        return "error"
    return "planning"


def route_after_planning(state: PipelineState) -> str:
    """Route after PLANNING: ERROR if failed, else VALIDATING."""
    if state.get("error_message"):
        return "error"
    if not state.get("waypoints"):
        return "error"
    return "validating"


def route_after_validating(state: PipelineState) -> str:
    """
    Route after VALIDATING — the core safety gate.
    
    - If unsafe → ERROR (always)
    - If requires HITL confirmation → stay at VALIDATING (requires_confirmation=True)
    - If safe and no HITL needed → EXECUTING
    """
    if state.get("error_message"):
        return "error"
    if not state.get("is_safe", False):
        return "error_unsafe"
    if state.get("requires_confirmation", False) and not state.get("human_confirmation_granted", False):
        return "hitl_required"
    return "executing"


# ---------------------------------------------------------------------------
# Build the graph
# ---------------------------------------------------------------------------


def build_pipeline_graph() -> StateGraph:
    """
    Construct the LangGraph StateGraph for the KINESYS pipeline.
    
    Returns the compiled graph ready for invocation.
    """
    graph = StateGraph(PipelineState)

    # Add nodes
    graph.add_node("idle", idle_node)
    graph.add_node("listening", listening_node)
    graph.add_node("decomposing", decomposing_node)
    graph.add_node("scene_analyzing", scene_analyzing_node)
    graph.add_node("planning", planning_node)
    graph.add_node("validating", validating_node)
    graph.add_node("executing", executing_node)
    graph.add_node("confirming", confirming_node)
    graph.add_node("error", error_node)

    # Set entry point
    graph.set_entry_point("idle")

    # Idle routing (start processing vs terminate)
    graph.add_conditional_edges(
        "idle",
        route_after_idle,
        {"listening": "listening", "end": END},
    )

    # Conditional edges
    graph.add_conditional_edges(
        "listening",
        route_after_listening,
        {"decomposing": "decomposing", "error": "error"},
    )

    graph.add_conditional_edges(
        "decomposing",
        route_after_decomposing,
        {"scene_analyzing": "scene_analyzing", "error": "error"},
    )

    graph.add_conditional_edges(
        "scene_analyzing",
        route_after_scene,
        {"planning": "planning", "error": "error"},
    )

    graph.add_conditional_edges(
        "planning",
        route_after_planning,
        {"validating": "validating", "error": "error"},
    )

    # The critical safety gate
    graph.add_conditional_edges(
        "validating",
        route_after_validating,
        {
            "executing": "executing",
            "error_unsafe": "error",
            "hitl_required": "error",
            "error": "error",
        },
    )

    # After execution → confirmation
    graph.add_edge("executing", "confirming")

    # Terminal nodes
    graph.add_edge("confirming", END)
    # Mandatory recovery path: ERROR -> IDLE
    graph.add_edge("error", "idle")

    return graph


def compile_pipeline():
    """Build and compile the pipeline graph."""
    graph = build_pipeline_graph()
    return graph.compile()


# ---------------------------------------------------------------------------
# Convenience runner
# ---------------------------------------------------------------------------


def run_pipeline(
    transcript: str,
    scene_data: Dict[str, Any],
    action_plan: List[Dict[str, Any]],
    decomposition_raw: str = "",
    confidence_scores: Optional[Dict[str, float]] = None,
    human_confirmation_granted: bool = False,
) -> PipelineState:
    """
    Run the full pipeline synchronously with pre-computed LLM results.

    In production, the LLM call happens asynchronously before the graph
    is invoked. The decomposition results are injected into the initial state.

    Returns the final PipelineState.
    """
    pipeline = compile_pipeline()

    initial_state: PipelineState = {
        "transcript": transcript,
        "scene_data": scene_data,
        "action_plan": action_plan,
        "decomposition_raw": decomposition_raw,
        "confidence_scores": confidence_scores or {},
        "human_confirmation_granted": human_confirmation_granted,
        "resume_from_idle": True,
    }

    result = pipeline.invoke(initial_state)
    return result


def get_pipeline_node_names() -> List[str]:
    """Return all node names for frontend visualization."""
    return [
        "IDLE",
        "LISTENING",
        "DECOMPOSING",
        "SCENE_ANALYZING",
        "PLANNING",
        "VALIDATING",
        "EXECUTING",
        "CONFIRMING",
        "ERROR",
    ]
