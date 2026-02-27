"""
KINESYS — Unit Tests for Action Primitives

Tests each of the 12 primitives for:
  - Waypoint generation with valid params
  - Waypoint generation error handling
  - Validation logic (pass/fail conditions)
  - Narration output
"""

from __future__ import annotations

import math
import pytest

from core.action_primitives import (
    Waypoint,
    SceneObject,
    SceneState,
    ValidationStatus,
    get_primitive,
    PRIMITIVE_REGISTRY,
    Approach,
    Grasp,
    Release,
    Translate,
    Rotate,
    Place,
    Push,
    Pour,
    Stack,
    Sort,
    Inspect,
    Wait,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def scene() -> SceneState:
    """A standard test scene with objects on a table."""
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
            "green_sphere": SceneObject(
                id="green_sphere",
                shape="sphere",
                color="green",
                position=(0.3, 0.67, -0.5),
                size=(0.12,),
                mass=0.2,
            ),
        },
        end_effector=(0.0, 1.5, 0.0),
        gripper_open=True,
        held_object_id=None,
        table_height=0.5,
    )


@pytest.fixture
def scene_holding(scene: SceneState) -> SceneState:
    """Scene where the robot is already holding the red cube."""
    scene.held_object_id = "red_cube"
    scene.gripper_open = False
    scene.objects["red_cube"].is_held = True
    return scene


# ---------------------------------------------------------------------------
# Registry tests
# ---------------------------------------------------------------------------


class TestRegistry:
    def test_all_12_primitives_registered(self) -> None:
        assert len(PRIMITIVE_REGISTRY) == 12

    def test_get_primitive_valid(self) -> None:
        prim = get_primitive("APPROACH")
        assert prim.primitive_id == "APPROACH"

    def test_get_primitive_case_insensitive(self) -> None:
        prim = get_primitive("approach")
        assert prim.primitive_id == "APPROACH"

    def test_get_primitive_unknown_raises(self) -> None:
        with pytest.raises(KeyError, match="Unknown action primitive"):
            get_primitive("NONEXISTENT")

    def test_all_primitives_have_ids(self) -> None:
        for name, prim in PRIMITIVE_REGISTRY.items():
            assert prim.primitive_id == name


# ---------------------------------------------------------------------------
# APPROACH
# ---------------------------------------------------------------------------


class TestApproach:
    def test_generates_waypoints(self, scene: SceneState) -> None:
        prim = Approach()
        wps = prim.generate_waypoints({"target": "red_cube"}, scene)
        assert len(wps) == 3
        assert all(isinstance(w, Waypoint) for w in wps)

    def test_final_waypoint_near_target(self, scene: SceneState) -> None:
        prim = Approach()
        wps = prim.generate_waypoints({"target": "red_cube"}, scene)
        last = wps[-1]
        obj = scene.objects["red_cube"]
        assert abs(last.x - obj.position[0]) < 0.2
        assert abs(last.z - obj.position[2]) < 0.2

    def test_gripper_open_on_approach(self, scene: SceneState) -> None:
        prim = Approach()
        wps = prim.generate_waypoints({"target": "red_cube"}, scene)
        assert all(w.gripper_open for w in wps)

    def test_validation_passes(self, scene: SceneState) -> None:
        prim = Approach()
        wps = prim.generate_waypoints({"target": "red_cube"}, scene)
        result = prim.validate(wps, scene)
        assert result.passed

    def test_validation_fails_below_table(self, scene: SceneState) -> None:
        prim = Approach()
        bad_wps = [Waypoint(x=0, y=0.1, z=0)]  # below table_height 0.5
        result = prim.validate(bad_wps, scene)
        assert not result.passed

    def test_unknown_target_raises(self, scene: SceneState) -> None:
        prim = Approach()
        with pytest.raises(ValueError, match="not found"):
            prim.generate_waypoints({"target": "nonexistent"}, scene)

    def test_describe(self) -> None:
        prim = Approach()
        assert "red_cube" in prim.describe({"target": "red_cube"})


# ---------------------------------------------------------------------------
# GRASP
# ---------------------------------------------------------------------------


class TestGrasp:
    def test_generates_waypoints(self, scene: SceneState) -> None:
        prim = Grasp()
        wps = prim.generate_waypoints({"target": "red_cube"}, scene)
        assert len(wps) == 2

    def test_gripper_closes(self, scene: SceneState) -> None:
        prim = Grasp()
        wps = prim.generate_waypoints({"target": "red_cube"}, scene)
        assert wps[0].gripper_open is True
        assert wps[-1].gripper_open is False

    def test_validation_fails_when_holding(self, scene_holding: SceneState) -> None:
        prim = Grasp()
        wps = prim.generate_waypoints({"target": "blue_cylinder"}, scene_holding)
        result = prim.validate(wps, scene_holding)
        assert not result.passed
        assert "Already holding" in result.reason

    def test_describe(self) -> None:
        prim = Grasp()
        assert "Grasping" in prim.describe({"target": "cube"})


# ---------------------------------------------------------------------------
# RELEASE
# ---------------------------------------------------------------------------


class TestRelease:
    def test_generates_waypoints(self, scene: SceneState) -> None:
        prim = Release()
        wps = prim.generate_waypoints({}, scene)
        assert len(wps) == 1
        assert wps[0].gripper_open is True

    def test_validation_warns_no_object(self, scene: SceneState) -> None:
        prim = Release()
        wps = prim.generate_waypoints({}, scene)
        result = prim.validate(wps, scene)
        assert result.status == ValidationStatus.WARNING

    def test_validation_passes_when_holding(self, scene_holding: SceneState) -> None:
        prim = Release()
        wps = prim.generate_waypoints({}, scene_holding)
        result = prim.validate(wps, scene_holding)
        assert result.passed


# ---------------------------------------------------------------------------
# TRANSLATE
# ---------------------------------------------------------------------------


class TestTranslate:
    def test_absolute_position(self, scene: SceneState) -> None:
        prim = Translate()
        wps = prim.generate_waypoints({"position": [0.5, 1.0, 0.5]}, scene)
        assert len(wps) == 3
        assert wps[-1].x == pytest.approx(0.5)
        assert wps[-1].z == pytest.approx(0.5)

    def test_relative_delta(self, scene: SceneState) -> None:
        prim = Translate()
        wps = prim.generate_waypoints({"delta": [0.1, 0.0, -0.2]}, scene)
        assert len(wps) == 3
        assert wps[-1].x == pytest.approx(scene.end_effector[0] + 0.1)

    def test_missing_params_raises(self, scene: SceneState) -> None:
        prim = Translate()
        with pytest.raises(ValueError, match="requires"):
            prim.generate_waypoints({}, scene)

    def test_describe_absolute(self) -> None:
        prim = Translate()
        desc = prim.describe({"position": [1.0, 1.0, 1.0]})
        assert "1.00" in desc

    def test_describe_delta(self) -> None:
        prim = Translate()
        desc = prim.describe({"delta": [0.1, 0.0, 0.0]})
        assert "0.10" in desc


# ---------------------------------------------------------------------------
# ROTATE
# ---------------------------------------------------------------------------


class TestRotate:
    def test_generates_waypoints(self, scene: SceneState) -> None:
        prim = Rotate()
        wps = prim.generate_waypoints({"axis": "y", "degrees": 90}, scene)
        assert len(wps) >= 2

    def test_final_angle_correct(self, scene: SceneState) -> None:
        prim = Rotate()
        wps = prim.generate_waypoints({"axis": "y", "degrees": 90}, scene)
        assert wps[-1].yaw == pytest.approx(math.radians(90), abs=0.01)

    def test_x_axis_rotation(self, scene: SceneState) -> None:
        prim = Rotate()
        wps = prim.generate_waypoints({"axis": "x", "degrees": 45}, scene)
        assert wps[-1].roll == pytest.approx(math.radians(45), abs=0.01)

    def test_describe(self) -> None:
        prim = Rotate()
        desc = prim.describe({"axis": "z", "degrees": 180})
        assert "180" in desc and "z" in desc


# ---------------------------------------------------------------------------
# PLACE
# ---------------------------------------------------------------------------


class TestPlace:
    def test_generates_waypoints(self, scene_holding: SceneState) -> None:
        prim = Place()
        wps = prim.generate_waypoints({"position": [0.5, 0.55, 0.5]}, scene_holding)
        assert len(wps) == 4

    def test_includes_release(self, scene_holding: SceneState) -> None:
        prim = Place()
        wps = prim.generate_waypoints({"position": [0.5, 0.55, 0.5]}, scene_holding)
        # At least one waypoint should have gripper_open=True
        assert any(w.gripper_open for w in wps)

    def test_validation_fails_without_object(self, scene: SceneState) -> None:
        prim = Place()
        wps = prim.generate_waypoints({"position": [0.5, 0.55, 0.5]}, scene)
        result = prim.validate(wps, scene)
        assert not result.passed

    def test_place_on_target(self, scene_holding: SceneState) -> None:
        prim = Place()
        wps = prim.generate_waypoints({"target": "blue_cylinder"}, scene_holding)
        assert len(wps) == 4


# ---------------------------------------------------------------------------
# PUSH
# ---------------------------------------------------------------------------


class TestPush:
    def test_generates_waypoints(self, scene: SceneState) -> None:
        prim = Push()
        wps = prim.generate_waypoints(
            {"target": "red_cube", "direction": [1, 0, 0], "distance": 0.2}, scene
        )
        assert len(wps) == 4

    def test_push_direction(self, scene: SceneState) -> None:
        prim = Push()
        wps = prim.generate_waypoints(
            {"target": "red_cube", "direction": [1, 0, 0], "distance": 0.3}, scene
        )
        obj = scene.objects["red_cube"]
        push_wp = wps[2]
        assert push_wp.x > obj.position[0]

    def test_zero_direction_raises(self, scene: SceneState) -> None:
        prim = Push()
        with pytest.raises(ValueError, match="zero magnitude"):
            prim.generate_waypoints(
                {"target": "red_cube", "direction": [0, 0, 0], "distance": 0.1}, scene
            )


# ---------------------------------------------------------------------------
# POUR
# ---------------------------------------------------------------------------


class TestPour:
    def test_generates_waypoints(self, scene_holding: SceneState) -> None:
        prim = Pour()
        wps = prim.generate_waypoints(
            {"target_container": "blue_cylinder", "angle": 90}, scene_holding
        )
        assert len(wps) >= 4

    def test_includes_tilt(self, scene_holding: SceneState) -> None:
        prim = Pour()
        wps = prim.generate_waypoints(
            {"target_container": "blue_cylinder", "angle": 90}, scene_holding
        )
        # Some waypoints should have non-zero roll
        assert any(w.roll != 0 for w in wps)

    def test_validation_fails_without_object(self, scene: SceneState) -> None:
        prim = Pour()
        wps = [Waypoint(x=0, y=1, z=0)]
        result = prim.validate(wps, scene)
        assert not result.passed


# ---------------------------------------------------------------------------
# STACK
# ---------------------------------------------------------------------------


class TestStack:
    def test_generates_waypoints(self, scene_holding: SceneState) -> None:
        prim = Stack()
        wps = prim.generate_waypoints({"target": "blue_cylinder"}, scene_holding)
        assert len(wps) == 4

    def test_stack_height(self, scene_holding: SceneState) -> None:
        prim = Stack()
        wps = prim.generate_waypoints({"target": "blue_cylinder"}, scene_holding)
        obj = scene_holding.objects["blue_cylinder"]
        stack_wp = wps[1]  # The descend waypoint
        assert stack_wp.y > obj.position[1]

    def test_validation_fails_without_object(self, scene: SceneState) -> None:
        prim = Stack()
        wps = [Waypoint(x=0, y=1, z=0)]
        result = prim.validate(wps, scene)
        assert not result.passed


# ---------------------------------------------------------------------------
# SORT
# ---------------------------------------------------------------------------


class TestSort:
    def test_generates_waypoints(self, scene: SceneState) -> None:
        prim = Sort()
        wps = prim.generate_waypoints(
            {
                "objects": ["red_cube", "blue_cylinder", "green_sphere"],
                "criterion": "color",
                "direction": "left_to_right",
            },
            scene,
        )
        # 8 waypoints per object × 3 objects = 24
        assert len(wps) == 24

    def test_describe(self) -> None:
        prim = Sort()
        desc = prim.describe({"criterion": "size", "direction": "left_to_right"})
        assert "size" in desc


# ---------------------------------------------------------------------------
# INSPECT
# ---------------------------------------------------------------------------


class TestInspect:
    def test_generates_waypoints(self, scene: SceneState) -> None:
        prim = Inspect()
        wps = prim.generate_waypoints({"target": "red_cube"}, scene)
        assert len(wps) == 2

    def test_looks_down(self, scene: SceneState) -> None:
        prim = Inspect()
        wps = prim.generate_waypoints({"target": "red_cube"}, scene)
        assert wps[0].pitch < 0  # Negative pitch = looking down


# ---------------------------------------------------------------------------
# WAIT
# ---------------------------------------------------------------------------


class TestWait:
    def test_generates_single_waypoint(self, scene: SceneState) -> None:
        prim = Wait()
        wps = prim.generate_waypoints({"duration_ms": 2000}, scene)
        assert len(wps) == 1

    def test_stays_at_current_position(self, scene: SceneState) -> None:
        prim = Wait()
        wps = prim.generate_waypoints({}, scene)
        assert wps[0].x == pytest.approx(scene.end_effector[0])
        assert wps[0].y == pytest.approx(scene.end_effector[1])
        assert wps[0].z == pytest.approx(scene.end_effector[2])

    def test_always_valid(self, scene: SceneState) -> None:
        prim = Wait()
        wps = prim.generate_waypoints({}, scene)
        result = prim.validate(wps, scene)
        assert result.passed

    def test_describe_with_condition(self) -> None:
        prim = Wait()
        desc = prim.describe({"condition": "object_settled"})
        assert "object_settled" in desc

    def test_describe_with_duration(self) -> None:
        prim = Wait()
        desc = prim.describe({"duration_ms": 500})
        assert "500" in desc
