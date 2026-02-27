"""
KINESYS — Trajectory Planner

Converts a list of abstract actions (from LLM task decomposition) into a
full waypoint sequence by:
  1. Resolving each action to its primitive class
  2. Calling each primitive's waypoint generator with the current scene state
  3. Running per-primitive validation
  4. Running full-trajectory safety validation
  5. Returning a consolidated plan with narration

The planner maintains a virtual scene state that evolves as actions are
planned, so that later actions see the effects of earlier ones.
"""

from __future__ import annotations

import copy
import logging
from dataclasses import dataclass, field
from typing import Any

from core.action_primitives import (
    Waypoint,
    SceneState,
    ValidationResult,
    ValidationStatus,
    get_primitive,
    PRIMITIVE_REGISTRY,
)
from core.safety_validator import (
    SafetyConfig,
    SafetyValidationResult,
    validate_trajectory,
    DEFAULT_SAFETY_CONFIG,
)

logger = logging.getLogger("kinesys.planner")

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class ActionStep:
    """A single action in the plan, with its resolved waypoints."""

    action_id: str
    params: dict[str, Any]
    waypoints: list[Waypoint]
    primitive_validation: ValidationResult
    narration: str
    index: int = 0


@dataclass
class TrajectoryPlan:
    """Complete trajectory plan produced by the planner."""

    steps: list[ActionStep]
    all_waypoints: list[Waypoint]
    safety_result: SafetyValidationResult
    narration_sequence: list[str]
    is_valid: bool
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "is_valid": self.is_valid,
            "error": self.error,
            "step_count": len(self.steps),
            "total_waypoints": len(self.all_waypoints),
            "narration": self.narration_sequence,
            "safety": self.safety_result.to_dict(),
            "steps": [
                {
                    "index": s.index,
                    "action": s.action_id,
                    "params": s.params,
                    "waypoint_count": len(s.waypoints),
                    "validation": {
                        "status": s.primitive_validation.status.value,
                        "reason": s.primitive_validation.reason,
                    },
                    "narration": s.narration,
                }
                for s in self.steps
            ],
        }


# ---------------------------------------------------------------------------
# Scene state updater
# ---------------------------------------------------------------------------


def _update_scene_after_action(
    scene: SceneState, action_id: str, params: dict[str, Any], waypoints: list[Waypoint]
) -> SceneState:
    """
    Evolve the virtual scene state based on what an action does.
    This allows later primitives to see effects of earlier ones.
    """
    updated = copy.deepcopy(scene)

    if waypoints:
        last_wp = waypoints[-1]
        updated.end_effector = (last_wp.x, last_wp.y, last_wp.z)
        updated.gripper_open = last_wp.gripper_open

    if action_id == "GRASP":
        target_id = params.get("target")
        if target_id and target_id in updated.objects:
            updated.held_object_id = target_id
            updated.objects[target_id].is_held = True
            updated.gripper_open = False

    elif action_id == "RELEASE":
        if updated.held_object_id and updated.held_object_id in updated.objects:
            obj = updated.objects[updated.held_object_id]
            obj.is_held = False
            obj.position = updated.end_effector
        updated.held_object_id = None
        updated.gripper_open = True

    elif action_id == "PLACE":
        if updated.held_object_id and updated.held_object_id in updated.objects:
            obj = updated.objects[updated.held_object_id]
            obj.is_held = False
            if waypoints:
                release_wp = next((w for w in waypoints if w.gripper_open), waypoints[-1])
                obj.position = (release_wp.x, release_wp.y, release_wp.z)
        updated.held_object_id = None
        updated.gripper_open = True

    elif action_id == "STACK":
        if updated.held_object_id and updated.held_object_id in updated.objects:
            obj = updated.objects[updated.held_object_id]
            obj.is_held = False
            if waypoints:
                release_wp = next((w for w in waypoints if w.gripper_open), waypoints[-1])
                obj.position = (release_wp.x, release_wp.y, release_wp.z)
        updated.held_object_id = None
        updated.gripper_open = True

    elif action_id == "TRANSLATE":
        if updated.held_object_id and updated.held_object_id in updated.objects:
            updated.objects[updated.held_object_id].position = updated.end_effector

    return updated


# ---------------------------------------------------------------------------
# Planner
# ---------------------------------------------------------------------------


def plan_trajectory(
    actions: list[dict[str, Any]],
    scene: SceneState,
    safety_config: SafetyConfig = DEFAULT_SAFETY_CONFIG,
) -> TrajectoryPlan:
    """
    Convert a list of abstract actions into a validated trajectory plan.

    Each action dict must have:
      - "action": str (primitive ID, e.g. "APPROACH")
      - "params": dict (primitive-specific parameters)

    Returns a TrajectoryPlan with all waypoints, per-step validation,
    full-trajectory safety check, and narration sequence.
    """
    steps: list[ActionStep] = []
    all_waypoints: list[Waypoint] = []
    narrations: list[str] = []
    current_scene = copy.deepcopy(scene)

    for i, action_def in enumerate(actions):
        action_id = action_def.get("action", "").upper()
        params = action_def.get("params", {})

        # Resolve primitive
        try:
            primitive = get_primitive(action_id)
        except KeyError as exc:
            logger.error("Unknown action at step %d: %s", i, action_id)
            return TrajectoryPlan(
                steps=steps,
                all_waypoints=all_waypoints,
                safety_result=SafetyValidationResult(
                    is_safe=False,
                    violations=[],
                    warnings=[],
                    summary=str(exc),
                ),
                narration_sequence=narrations,
                is_valid=False,
                error=str(exc),
            )

        # Generate waypoints
        try:
            waypoints = primitive.generate_waypoints(params, current_scene)
        except (ValueError, KeyError) as exc:
            logger.error("Waypoint generation failed at step %d: %s", i, exc)
            return TrajectoryPlan(
                steps=steps,
                all_waypoints=all_waypoints,
                safety_result=SafetyValidationResult(
                    is_safe=False,
                    violations=[],
                    warnings=[],
                    summary=f"Step {i} ({action_id}): {exc}",
                ),
                narration_sequence=narrations,
                is_valid=False,
                error=f"Step {i} ({action_id}): {exc}",
            )

        # Per-primitive validation
        prim_result = primitive.validate(waypoints, current_scene)

        if prim_result.status == ValidationStatus.FAIL:
            logger.warning(
                "Primitive validation failed at step %d (%s): %s",
                i, action_id, prim_result.reason,
            )
            return TrajectoryPlan(
                steps=steps,
                all_waypoints=all_waypoints,
                safety_result=SafetyValidationResult(
                    is_safe=False,
                    violations=[],
                    warnings=[],
                    summary=f"Step {i} ({action_id}) failed: {prim_result.reason}",
                ),
                narration_sequence=narrations,
                is_valid=False,
                error=f"Step {i} ({action_id}): {prim_result.reason}",
            )

        # Narration
        narration = primitive.describe(params)
        narrations.append(narration)

        step = ActionStep(
            action_id=action_id,
            params=params,
            waypoints=waypoints,
            primitive_validation=prim_result,
            narration=narration,
            index=i,
        )
        steps.append(step)
        all_waypoints.extend(waypoints)

        # Update virtual scene state
        current_scene = _update_scene_after_action(
            current_scene, action_id, params, waypoints
        )

    # Full-trajectory safety validation
    safety_result = validate_trajectory(all_waypoints, scene, safety_config)

    is_valid = safety_result.is_safe
    error = None if is_valid else safety_result.summary

    if is_valid:
        logger.info(
            "Trajectory plan valid: %d steps, %d waypoints",
            len(steps),
            len(all_waypoints),
        )
    else:
        logger.warning("Trajectory plan FAILED safety: %s", safety_result.summary)

    return TrajectoryPlan(
        steps=steps,
        all_waypoints=all_waypoints,
        safety_result=safety_result,
        narration_sequence=narrations,
        is_valid=is_valid,
        error=error,
    )


def list_available_primitives() -> list[dict[str, str]]:
    """Return metadata for all registered action primitives."""
    return [
        {
            "id": prim.primitive_id,
            "description": prim.description,
        }
        for prim in PRIMITIVE_REGISTRY.values()
    ]
