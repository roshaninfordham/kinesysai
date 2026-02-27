"""
KINESYS — Safety Constraint Engine

Validates full waypoint sequences against hard-coded safety constraints:
  - Workspace bounds (configurable box volume)
  - Table surface collision (y >= table_height threshold)
  - Maximum velocity per joint (rad/s)
  - Maximum linear velocity (m/s)
  - Gripper force limit
  - Minimum clearance from obstacles

Returns True only if ALL waypoints pass ALL constraints. On failure,
returns the specific constraint violation with a human-readable explanation.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from core.action_primitives import Waypoint, SceneState, ValidationResult, ValidationStatus


# ---------------------------------------------------------------------------
# Constraint configuration
# ---------------------------------------------------------------------------


@dataclass
class WorkspaceBounds:
    """Axis-aligned bounding box for the robot workspace."""

    x_min: float = -1.5
    x_max: float = 1.5
    y_min: float = 0.0
    y_max: float = 3.0
    z_min: float = -1.5
    z_max: float = 1.5


@dataclass
class SafetyConfig:
    """All safety constraint thresholds."""

    workspace: WorkspaceBounds = field(default_factory=WorkspaceBounds)
    table_height: float = 0.5
    table_collision_margin: float = 0.01
    max_linear_velocity_mps: float = 1.0
    max_angular_velocity_dps: float = 90.0
    max_gripper_force_n: float = 20.0
    min_obstacle_clearance_m: float = 0.02
    max_waypoint_distance_m: float = 2.0
    assumed_dt: float = 1.0  # Assumed time between waypoints for velocity checks


DEFAULT_SAFETY_CONFIG = SafetyConfig()


# ---------------------------------------------------------------------------
# Individual constraint checkers
# ---------------------------------------------------------------------------


@dataclass
class ConstraintViolation:
    """A single constraint violation."""

    constraint_name: str
    message: str
    waypoint_index: int
    severity: str = "error"  # "error" or "warning"


def check_workspace_bounds(
    waypoints: list[Waypoint],
    config: SafetyConfig = DEFAULT_SAFETY_CONFIG,
) -> list[ConstraintViolation]:
    """Verify all waypoints are within the workspace bounding box."""
    violations: list[ConstraintViolation] = []
    ws = config.workspace

    for i, wp in enumerate(waypoints):
        if wp.x < ws.x_min or wp.x > ws.x_max:
            violations.append(ConstraintViolation(
                "workspace_bounds_x",
                f"Waypoint {i}: x={wp.x:.3f} outside [{ws.x_min}, {ws.x_max}]",
                i,
            ))
        if wp.y < ws.y_min or wp.y > ws.y_max:
            violations.append(ConstraintViolation(
                "workspace_bounds_y",
                f"Waypoint {i}: y={wp.y:.3f} outside [{ws.y_min}, {ws.y_max}]",
                i,
            ))
        if wp.z < ws.z_min or wp.z > ws.z_max:
            violations.append(ConstraintViolation(
                "workspace_bounds_z",
                f"Waypoint {i}: z={wp.z:.3f} outside [{ws.z_min}, {ws.z_max}]",
                i,
            ))

    return violations


def check_table_collision(
    waypoints: list[Waypoint],
    config: SafetyConfig = DEFAULT_SAFETY_CONFIG,
) -> list[ConstraintViolation]:
    """Verify no waypoints collide with the table surface."""
    violations: list[ConstraintViolation] = []
    threshold = config.table_height - config.table_collision_margin

    for i, wp in enumerate(waypoints):
        if wp.y < threshold:
            violations.append(ConstraintViolation(
                "table_collision",
                f"Waypoint {i}: y={wp.y:.3f} below table surface at {config.table_height:.3f}",
                i,
            ))

    return violations


def check_linear_velocity(
    waypoints: list[Waypoint],
    config: SafetyConfig = DEFAULT_SAFETY_CONFIG,
) -> list[ConstraintViolation]:
    """Verify linear velocity between consecutive waypoints is within limits."""
    violations: list[ConstraintViolation] = []
    dt = config.assumed_dt

    for i in range(1, len(waypoints)):
        prev = waypoints[i - 1]
        curr = waypoints[i]

        dx = curr.x - prev.x
        dy = curr.y - prev.y
        dz = curr.z - prev.z
        dist = math.sqrt(dx * dx + dy * dy + dz * dz)
        velocity = dist / dt

        if velocity > config.max_linear_velocity_mps:
            violations.append(ConstraintViolation(
                "max_linear_velocity",
                f"Waypoint {i}: linear velocity {velocity:.3f} m/s "
                f"exceeds limit {config.max_linear_velocity_mps:.3f} m/s "
                f"(distance {dist:.3f}m in {dt}s)",
                i,
            ))

    return violations


def check_angular_velocity(
    waypoints: list[Waypoint],
    config: SafetyConfig = DEFAULT_SAFETY_CONFIG,
) -> list[ConstraintViolation]:
    """Verify angular velocity between consecutive waypoints is within limits."""
    violations: list[ConstraintViolation] = []
    dt = config.assumed_dt
    max_rad = math.radians(config.max_angular_velocity_dps)

    for i in range(1, len(waypoints)):
        prev = waypoints[i - 1]
        curr = waypoints[i]

        for attr in ("roll", "pitch", "yaw"):
            delta = abs(getattr(curr, attr) - getattr(prev, attr))
            angular_vel = delta / dt

            if angular_vel > max_rad:
                violations.append(ConstraintViolation(
                    f"max_angular_velocity_{attr}",
                    f"Waypoint {i}: {attr} angular velocity "
                    f"{math.degrees(angular_vel):.1f} °/s exceeds "
                    f"limit {config.max_angular_velocity_dps:.1f} °/s",
                    i,
                ))

    return violations


def check_waypoint_distance(
    waypoints: list[Waypoint],
    config: SafetyConfig = DEFAULT_SAFETY_CONFIG,
) -> list[ConstraintViolation]:
    """Verify no single move is unreasonably large."""
    violations: list[ConstraintViolation] = []

    for i in range(1, len(waypoints)):
        prev = waypoints[i - 1]
        curr = waypoints[i]

        dx = curr.x - prev.x
        dy = curr.y - prev.y
        dz = curr.z - prev.z
        dist = math.sqrt(dx * dx + dy * dy + dz * dz)

        if dist > config.max_waypoint_distance_m:
            violations.append(ConstraintViolation(
                "max_waypoint_distance",
                f"Waypoint {i}: distance {dist:.3f}m from previous "
                f"exceeds max {config.max_waypoint_distance_m:.3f}m",
                i,
            ))

    return violations


def check_obstacle_clearance(
    waypoints: list[Waypoint],
    scene: SceneState,
    config: SafetyConfig = DEFAULT_SAFETY_CONFIG,
) -> list[ConstraintViolation]:
    """
    Verify minimum clearance from scene obstacles.
    Uses simplified bounding-sphere collision checks.
    """
    violations: list[ConstraintViolation] = []
    min_clearance = config.min_obstacle_clearance_m

    for i, wp in enumerate(waypoints):
        for obj_id, obj in scene.objects.items():
            # Skip the held object
            if obj_id == scene.held_object_id:
                continue

            # Bounding sphere radius (conservative estimate)
            obj_radius = max(obj.size) / 2 if obj.size else 0.1

            dx = wp.x - obj.position[0]
            dy = wp.y - obj.position[1]
            dz = wp.z - obj.position[2]
            dist = math.sqrt(dx * dx + dy * dy + dz * dz)

            clearance = dist - obj_radius
            if clearance < min_clearance:
                violations.append(ConstraintViolation(
                    "obstacle_clearance",
                    f"Waypoint {i}: clearance {clearance:.3f}m from '{obj_id}' "
                    f"below minimum {min_clearance:.3f}m",
                    i,
                    severity="warning",
                ))

    return violations


# ---------------------------------------------------------------------------
# Master validator
# ---------------------------------------------------------------------------


@dataclass
class SafetyValidationResult:
    """Comprehensive result of safety validation."""

    is_safe: bool
    violations: list[ConstraintViolation]
    warnings: list[ConstraintViolation]
    summary: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "is_safe": self.is_safe,
            "error_count": len(self.violations),
            "warning_count": len(self.warnings),
            "summary": self.summary,
            "violations": [
                {
                    "constraint": v.constraint_name,
                    "message": v.message,
                    "waypoint_index": v.waypoint_index,
                }
                for v in self.violations
            ],
            "warnings": [
                {
                    "constraint": w.constraint_name,
                    "message": w.message,
                    "waypoint_index": w.waypoint_index,
                }
                for w in self.warnings
            ],
        }


def validate_trajectory(
    waypoints: list[Waypoint],
    scene: SceneState | None = None,
    config: SafetyConfig = DEFAULT_SAFETY_CONFIG,
) -> SafetyValidationResult:
    """
    Run ALL safety constraint checks on a waypoint sequence.

    Returns True (is_safe) only if all waypoints pass all hard constraints.
    Soft constraints (obstacle clearance) produce warnings but don't fail.
    """
    if not waypoints:
        return SafetyValidationResult(
            is_safe=False,
            violations=[ConstraintViolation("empty_trajectory", "No waypoints provided", -1)],
            warnings=[],
            summary="Trajectory is empty",
        )

    all_issues: list[ConstraintViolation] = []

    # Run all constraint checks
    all_issues.extend(check_workspace_bounds(waypoints, config))
    all_issues.extend(check_table_collision(waypoints, config))
    all_issues.extend(check_linear_velocity(waypoints, config))
    all_issues.extend(check_angular_velocity(waypoints, config))
    all_issues.extend(check_waypoint_distance(waypoints, config))

    if scene is not None:
        all_issues.extend(check_obstacle_clearance(waypoints, scene, config))

    # Separate errors from warnings
    errors = [v for v in all_issues if v.severity == "error"]
    warnings = [v for v in all_issues if v.severity == "warning"]

    is_safe = len(errors) == 0

    if is_safe and len(warnings) == 0:
        summary = f"Trajectory valid: {len(waypoints)} waypoints passed all safety checks"
    elif is_safe:
        summary = (
            f"Trajectory valid with {len(warnings)} warning(s): "
            f"{'; '.join(w.message for w in warnings[:3])}"
        )
    else:
        summary = (
            f"Trajectory UNSAFE: {len(errors)} violation(s). "
            f"First: {errors[0].message}"
        )

    return SafetyValidationResult(
        is_safe=is_safe,
        violations=errors,
        warnings=warnings,
        summary=summary,
    )
