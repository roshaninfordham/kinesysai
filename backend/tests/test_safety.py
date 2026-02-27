"""
KINESYS — Unit Tests for Safety Validator & Trajectory Planner

Tests the constraint engine for:
  - Workspace bounds checking
  - Table collision detection
  - Linear velocity limits
  - Angular velocity limits
  - Waypoint distance limits
  - Obstacle clearance
  - Master validator integration
  - Trajectory planner end-to-end
"""

from __future__ import annotations

import math
import pytest

from core.action_primitives import Waypoint, SceneObject, SceneState
from core.safety_validator import (
    SafetyConfig,
    WorkspaceBounds,
    ConstraintViolation,
    SafetyValidationResult,
    check_workspace_bounds,
    check_table_collision,
    check_linear_velocity,
    check_angular_velocity,
    check_waypoint_distance,
    check_obstacle_clearance,
    validate_trajectory,
    DEFAULT_SAFETY_CONFIG,
)
from core.trajectory_planner import plan_trajectory, list_available_primitives


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def config() -> SafetyConfig:
    return SafetyConfig(
        workspace=WorkspaceBounds(
            x_min=-1.5, x_max=1.5,
            y_min=0.0, y_max=3.0,
            z_min=-1.5, z_max=1.5,
        ),
        table_height=0.5,
        max_linear_velocity_mps=1.0,
        max_angular_velocity_dps=90.0,
        max_waypoint_distance_m=2.0,
        assumed_dt=1.0,
    )


@pytest.fixture
def scene() -> SceneState:
    return SceneState(
        objects={
            "red_cube": SceneObject(
                id="red_cube",
                shape="box",
                color="red",
                position=(0.5, 0.65, 0.3),
                size=(0.2, 0.2, 0.2),
                mass=0.5,
            ),
            "blue_cylinder": SceneObject(
                id="blue_cylinder",
                shape="cylinder",
                color="blue",
                position=(-0.5, 0.7, 0.6),
                size=(0.1, 0.3),
                mass=0.3,
            ),
        },
        end_effector=(0.0, 1.5, 0.0),
        gripper_open=True,
        held_object_id=None,
        table_height=0.5,
    )


@pytest.fixture
def scene_holding(scene: SceneState) -> SceneState:
    scene.held_object_id = "red_cube"
    scene.gripper_open = False
    scene.objects["red_cube"].is_held = True
    return scene


def _make_wp(x: float = 0.0, y: float = 1.0, z: float = 0.0, **kw) -> Waypoint:
    return Waypoint(x=x, y=y, z=z, **kw)


# ---------------------------------------------------------------------------
# Workspace Bounds
# ---------------------------------------------------------------------------


class TestWorkspaceBounds:
    def test_valid_waypoints(self, config: SafetyConfig) -> None:
        wps = [_make_wp(0, 1, 0), _make_wp(0.5, 1.5, -0.3)]
        violations = check_workspace_bounds(wps, config)
        assert len(violations) == 0

    def test_x_out_of_bounds(self, config: SafetyConfig) -> None:
        wps = [_make_wp(2.0, 1, 0)]  # x=2.0 > x_max=1.5
        violations = check_workspace_bounds(wps, config)
        assert len(violations) == 1
        assert violations[0].constraint_name == "workspace_bounds_x"

    def test_y_below_bounds(self, config: SafetyConfig) -> None:
        wps = [_make_wp(0, -0.5, 0)]  # y=-0.5 < y_min=0.0
        violations = check_workspace_bounds(wps, config)
        assert len(violations) == 1
        assert violations[0].constraint_name == "workspace_bounds_y"

    def test_z_out_of_bounds(self, config: SafetyConfig) -> None:
        wps = [_make_wp(0, 1, -2.0)]  # z=-2.0 < z_min=-1.5
        violations = check_workspace_bounds(wps, config)
        assert len(violations) == 1
        assert violations[0].constraint_name == "workspace_bounds_z"

    def test_multiple_violations(self, config: SafetyConfig) -> None:
        wps = [_make_wp(5.0, -1.0, 5.0)]
        violations = check_workspace_bounds(wps, config)
        assert len(violations) == 3  # x, y, z all out of bounds


# ---------------------------------------------------------------------------
# Table Collision
# ---------------------------------------------------------------------------


class TestTableCollision:
    def test_above_table_ok(self, config: SafetyConfig) -> None:
        wps = [_make_wp(0, 0.6, 0), _make_wp(0, 1.0, 0)]
        violations = check_table_collision(wps, config)
        assert len(violations) == 0

    def test_below_table_fails(self, config: SafetyConfig) -> None:
        wps = [_make_wp(0, 0.3, 0)]  # 0.3 < 0.5 - 0.01
        violations = check_table_collision(wps, config)
        assert len(violations) == 1
        assert violations[0].constraint_name == "table_collision"

    def test_at_table_surface_ok(self, config: SafetyConfig) -> None:
        wps = [_make_wp(0, 0.5, 0)]  # exactly at table height
        violations = check_table_collision(wps, config)
        assert len(violations) == 0

    def test_just_below_margin_fails(self, config: SafetyConfig) -> None:
        wps = [_make_wp(0, 0.48, 0)]  # 0.48 < 0.5 - 0.01 = 0.49
        violations = check_table_collision(wps, config)
        assert len(violations) == 1


# ---------------------------------------------------------------------------
# Linear Velocity
# ---------------------------------------------------------------------------


class TestLinearVelocity:
    def test_slow_movement_ok(self, config: SafetyConfig) -> None:
        wps = [_make_wp(0, 1, 0), _make_wp(0.1, 1, 0)]
        violations = check_linear_velocity(wps, config)
        assert len(violations) == 0

    def test_fast_movement_fails(self, config: SafetyConfig) -> None:
        # Distance = 1.5m in 1.0s = 1.5 m/s > 1.0 m/s limit
        wps = [_make_wp(0, 1, 0), _make_wp(1.5, 1, 0)]
        violations = check_linear_velocity(wps, config)
        assert len(violations) == 1
        assert violations[0].constraint_name == "max_linear_velocity"

    def test_single_waypoint_ok(self, config: SafetyConfig) -> None:
        wps = [_make_wp(0, 1, 0)]
        violations = check_linear_velocity(wps, config)
        assert len(violations) == 0


# ---------------------------------------------------------------------------
# Angular Velocity
# ---------------------------------------------------------------------------


class TestAngularVelocity:
    def test_slow_rotation_ok(self, config: SafetyConfig) -> None:
        wps = [
            _make_wp(0, 1, 0, yaw=0),
            _make_wp(0, 1, 0, yaw=math.radians(30)),
        ]
        violations = check_angular_velocity(wps, config)
        assert len(violations) == 0

    def test_fast_rotation_fails(self, config: SafetyConfig) -> None:
        # 120° in 1.0s = 120°/s > 90°/s limit
        wps = [
            _make_wp(0, 1, 0, roll=0),
            _make_wp(0, 1, 0, roll=math.radians(120)),
        ]
        violations = check_angular_velocity(wps, config)
        assert len(violations) == 1
        assert "roll" in violations[0].constraint_name


# ---------------------------------------------------------------------------
# Waypoint Distance
# ---------------------------------------------------------------------------


class TestWaypointDistance:
    def test_short_distance_ok(self, config: SafetyConfig) -> None:
        wps = [_make_wp(0, 1, 0), _make_wp(0.5, 1, 0)]
        violations = check_waypoint_distance(wps, config)
        assert len(violations) == 0

    def test_huge_jump_fails(self, config: SafetyConfig) -> None:
        wps = [_make_wp(0, 1, 0), _make_wp(3.0, 1, 0)]
        violations = check_waypoint_distance(wps, config)
        assert len(violations) == 1
        assert violations[0].constraint_name == "max_waypoint_distance"


# ---------------------------------------------------------------------------
# Obstacle Clearance
# ---------------------------------------------------------------------------


class TestObstacleClearance:
    def test_far_from_objects_ok(self, scene: SceneState, config: SafetyConfig) -> None:
        wps = [_make_wp(0, 2.0, 0)]  # well above objects
        violations = check_obstacle_clearance(wps, scene, config)
        assert len(violations) == 0

    def test_near_object_warns(self, scene: SceneState, config: SafetyConfig) -> None:
        obj = scene.objects["red_cube"]
        wps = [_make_wp(obj.position[0], obj.position[1], obj.position[2])]
        violations = check_obstacle_clearance(wps, scene, config)
        assert len(violations) >= 1
        assert all(v.severity == "warning" for v in violations)

    def test_held_object_excluded(self, scene_holding: SceneState, config: SafetyConfig) -> None:
        obj = scene_holding.objects["red_cube"]
        wps = [_make_wp(obj.position[0], obj.position[1], obj.position[2])]
        violations = check_obstacle_clearance(wps, scene_holding, config)
        # Should not warn about the held object
        red_violations = [v for v in violations if "red_cube" in v.message]
        assert len(red_violations) == 0


# ---------------------------------------------------------------------------
# Master Validator
# ---------------------------------------------------------------------------


class TestMasterValidator:
    def test_valid_trajectory(self, config: SafetyConfig) -> None:
        wps = [
            _make_wp(0, 1.0, 0),
            _make_wp(0.1, 1.0, 0),
            _make_wp(0.2, 1.0, 0),
        ]
        result = validate_trajectory(wps, config=config)
        assert result.is_safe
        assert len(result.violations) == 0

    def test_empty_trajectory_fails(self, config: SafetyConfig) -> None:
        result = validate_trajectory([], config=config)
        assert not result.is_safe

    def test_unsafe_trajectory(self, config: SafetyConfig) -> None:
        wps = [
            _make_wp(0, 1.0, 0),
            _make_wp(0, -1.0, 0),  # below workspace
        ]
        result = validate_trajectory(wps, config=config)
        assert not result.is_safe
        assert len(result.violations) > 0

    def test_to_dict(self, config: SafetyConfig) -> None:
        wps = [_make_wp(0, 1.0, 0)]
        result = validate_trajectory(wps, config=config)
        d = result.to_dict()
        assert "is_safe" in d
        assert "error_count" in d
        assert "summary" in d


# ---------------------------------------------------------------------------
# Trajectory Planner Integration
# ---------------------------------------------------------------------------


class TestTrajectoryPlanner:
    def test_simple_approach_grasp(self, scene: SceneState) -> None:
        actions = [
            {"action": "APPROACH", "params": {"target": "red_cube"}},
            {"action": "GRASP", "params": {"target": "red_cube"}},
        ]
        plan = plan_trajectory(actions, scene)
        assert len(plan.steps) == 2
        assert len(plan.all_waypoints) > 0
        assert len(plan.narration_sequence) == 2

    def test_full_pick_and_place(self, scene: SceneState) -> None:
        actions = [
            {"action": "APPROACH", "params": {"target": "red_cube"}},
            {"action": "GRASP", "params": {"target": "red_cube"}},
            {"action": "TRANSLATE", "params": {"position": [0.0, 1.0, 0.0]}},
            {"action": "PLACE", "params": {"position": [0.0, 0.55, 0.5]}},
        ]
        plan = plan_trajectory(actions, scene)
        assert len(plan.steps) == 4
        assert plan.is_valid

    def test_unknown_action_fails(self, scene: SceneState) -> None:
        actions = [{"action": "FLY", "params": {}}]
        plan = plan_trajectory(actions, scene)
        assert not plan.is_valid
        assert plan.error is not None

    def test_missing_target_fails(self, scene: SceneState) -> None:
        actions = [{"action": "APPROACH", "params": {"target": "nonexistent"}}]
        plan = plan_trajectory(actions, scene)
        assert not plan.is_valid

    def test_plan_to_dict(self, scene: SceneState) -> None:
        actions = [{"action": "WAIT", "params": {"duration_ms": 1000}}]
        plan = plan_trajectory(actions, scene)
        d = plan.to_dict()
        assert "steps" in d
        assert "narration" in d
        assert d["step_count"] == 1

    def test_scene_state_evolves(self, scene: SceneState) -> None:
        """After GRASP, subsequent PLACE should know we're holding an object."""
        actions = [
            {"action": "APPROACH", "params": {"target": "red_cube"}},
            {"action": "GRASP", "params": {"target": "red_cube"}},
            {"action": "PLACE", "params": {"position": [0.0, 0.55, 0.5]}},
        ]
        plan = plan_trajectory(actions, scene)
        # PLACE should succeed because scene evolves to show held object
        assert len(plan.steps) == 3

    def test_list_available_primitives(self) -> None:
        prims = list_available_primitives()
        assert len(prims) == 12
        ids = {p["id"] for p in prims}
        assert "APPROACH" in ids
        assert "WAIT" in ids
