"""
KINESYS — Action Primitive Library

Implements 12 parameterized robot action primitives. Each primitive class
provides:
  - generate_waypoints(params, scene_state) → list[Waypoint]
  - validate(waypoints, scene_state) → ValidationResult
  - describe() → str   (human-readable for TTS narration)
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Waypoint:
    """A single 6-DOF robot pose + gripper state."""

    x: float
    y: float
    z: float
    roll: float = 0.0
    pitch: float = 0.0
    yaw: float = 0.0
    gripper_open: bool = True


@dataclass
class SceneObject:
    """An object in the simulation scene."""

    id: str
    shape: str
    color: str
    position: tuple[float, float, float]
    size: tuple[float, ...]
    mass: float = 0.0
    is_held: bool = False


@dataclass
class SceneState:
    """Current state of the simulation scene."""

    objects: dict[str, SceneObject] = field(default_factory=dict)
    end_effector: tuple[float, float, float] = (0.0, 1.5, 0.0)
    gripper_open: bool = True
    held_object_id: str | None = None
    table_height: float = 0.5


class ValidationStatus(Enum):
    PASS = "pass"
    FAIL = "fail"
    WARNING = "warning"


@dataclass
class ValidationResult:
    """Result of a safety validation check."""

    status: ValidationStatus
    reason: str
    constraint: str = ""
    waypoint_index: int | None = None

    @property
    def passed(self) -> bool:
        return self.status == ValidationStatus.PASS


# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------


class ActionPrimitive(ABC):
    """Base class for all action primitives."""

    primitive_id: str = ""
    description: str = ""

    @abstractmethod
    def generate_waypoints(
        self, params: dict[str, Any], scene: SceneState
    ) -> list[Waypoint]:
        ...

    @abstractmethod
    def validate(
        self, waypoints: list[Waypoint], scene: SceneState
    ) -> ValidationResult:
        ...

    @abstractmethod
    def describe(self, params: dict[str, Any] | None = None) -> str:
        ...

    def _get_object(self, scene: SceneState, object_id: str) -> SceneObject:
        """Retrieve an object from the scene or raise."""
        obj = scene.objects.get(object_id)
        if obj is None:
            raise ValueError(f"Object '{object_id}' not found in scene")
        return obj


# ---------------------------------------------------------------------------
# 1. APPROACH
# ---------------------------------------------------------------------------


class Approach(ActionPrimitive):
    primitive_id = "APPROACH"
    description = "Move end-effector near a target object"

    def generate_waypoints(
        self, params: dict[str, Any], scene: SceneState
    ) -> list[Waypoint]:
        target_id: str = params["target"]
        offset = params.get("offset", [0.0, 0.05, 0.0])
        obj = self._get_object(scene, target_id)

        # Lift to safe height first
        safe_y = max(scene.table_height + 0.4, scene.end_effector[1])
        wp_lift = Waypoint(
            x=scene.end_effector[0],
            y=safe_y,
            z=scene.end_effector[2],
            gripper_open=scene.gripper_open,
        )

        # Move above target
        wp_above = Waypoint(
            x=obj.position[0] + offset[0],
            y=safe_y,
            z=obj.position[2] + offset[2],
            gripper_open=True,
        )

        # Descend to offset position
        wp_approach = Waypoint(
            x=obj.position[0] + offset[0],
            y=obj.position[1] + offset[1],
            z=obj.position[2] + offset[2],
            gripper_open=True,
        )

        return [wp_lift, wp_above, wp_approach]

    def validate(
        self, waypoints: list[Waypoint], scene: SceneState
    ) -> ValidationResult:
        for i, wp in enumerate(waypoints):
            if wp.y < scene.table_height:
                return ValidationResult(
                    ValidationStatus.FAIL,
                    f"Waypoint {i} below table surface (y={wp.y:.3f})",
                    "table_collision",
                    i,
                )
        return ValidationResult(ValidationStatus.PASS, "Approach trajectory valid")

    def describe(self, params: dict[str, Any] | None = None) -> str:
        target = params.get("target", "object") if params else "object"
        return f"Approaching {target}"


# ---------------------------------------------------------------------------
# 2. GRASP
# ---------------------------------------------------------------------------


class Grasp(ActionPrimitive):
    primitive_id = "GRASP"
    description = "Close gripper to grasp a target object"

    def generate_waypoints(
        self, params: dict[str, Any], scene: SceneState
    ) -> list[Waypoint]:
        target_id: str = params["target"]
        obj = self._get_object(scene, target_id)

        # Move to object center
        wp_position = Waypoint(
            x=obj.position[0],
            y=obj.position[1],
            z=obj.position[2],
            gripper_open=True,
        )

        # Close gripper
        wp_grasp = Waypoint(
            x=obj.position[0],
            y=obj.position[1],
            z=obj.position[2],
            gripper_open=False,
        )

        return [wp_position, wp_grasp]

    def validate(
        self, waypoints: list[Waypoint], scene: SceneState
    ) -> ValidationResult:
        if scene.held_object_id is not None:
            return ValidationResult(
                ValidationStatus.FAIL,
                f"Already holding object '{scene.held_object_id}'",
                "gripper_occupied",
            )
        return ValidationResult(ValidationStatus.PASS, "Grasp valid")

    def describe(self, params: dict[str, Any] | None = None) -> str:
        target = params.get("target", "object") if params else "object"
        return f"Grasping {target}"


# ---------------------------------------------------------------------------
# 3. RELEASE
# ---------------------------------------------------------------------------


class Release(ActionPrimitive):
    primitive_id = "RELEASE"
    description = "Open gripper to release held object"

    def generate_waypoints(
        self, params: dict[str, Any], scene: SceneState
    ) -> list[Waypoint]:
        # Open gripper at current position
        wp = Waypoint(
            x=scene.end_effector[0],
            y=scene.end_effector[1],
            z=scene.end_effector[2],
            gripper_open=True,
        )
        return [wp]

    def validate(
        self, waypoints: list[Waypoint], scene: SceneState
    ) -> ValidationResult:
        if scene.held_object_id is None:
            return ValidationResult(
                ValidationStatus.WARNING,
                "No object currently held — release is a no-op",
                "no_object_held",
            )
        return ValidationResult(ValidationStatus.PASS, "Release valid")

    def describe(self, params: dict[str, Any] | None = None) -> str:
        return "Releasing object"


# ---------------------------------------------------------------------------
# 4. TRANSLATE
# ---------------------------------------------------------------------------


class Translate(ActionPrimitive):
    primitive_id = "TRANSLATE"
    description = "Move end-effector to an absolute or relative position"

    def generate_waypoints(
        self, params: dict[str, Any], scene: SceneState
    ) -> list[Waypoint]:
        gripper = not scene.gripper_open if scene.held_object_id else scene.gripper_open

        if "position" in params:
            pos = params["position"]
            target = (float(pos[0]), float(pos[1]), float(pos[2]))
        elif "delta" in params:
            d = params["delta"]
            target = (
                scene.end_effector[0] + float(d[0]),
                scene.end_effector[1] + float(d[1]),
                scene.end_effector[2] + float(d[2]),
            )
        else:
            raise ValueError("TRANSLATE requires 'position' or 'delta'")

        # Safe lift, lateral move, descend
        safe_y = max(scene.table_height + 0.4, scene.end_effector[1], target[1])

        wp_lift = Waypoint(
            x=scene.end_effector[0],
            y=safe_y,
            z=scene.end_effector[2],
            gripper_open=gripper,
        )
        wp_lateral = Waypoint(
            x=target[0], y=safe_y, z=target[2], gripper_open=gripper
        )
        wp_descend = Waypoint(
            x=target[0], y=target[1], z=target[2], gripper_open=gripper
        )

        return [wp_lift, wp_lateral, wp_descend]

    def validate(
        self, waypoints: list[Waypoint], scene: SceneState
    ) -> ValidationResult:
        for i, wp in enumerate(waypoints):
            if wp.y < scene.table_height:
                return ValidationResult(
                    ValidationStatus.FAIL,
                    f"Waypoint {i} below table (y={wp.y:.3f})",
                    "table_collision",
                    i,
                )
        return ValidationResult(ValidationStatus.PASS, "Translation valid")

    def describe(self, params: dict[str, Any] | None = None) -> str:
        if params and "position" in params:
            p = params["position"]
            return f"Moving to position ({p[0]:.2f}, {p[1]:.2f}, {p[2]:.2f})"
        if params and "delta" in params:
            d = params["delta"]
            return f"Moving by ({d[0]:.2f}, {d[1]:.2f}, {d[2]:.2f})"
        return "Translating end-effector"


# ---------------------------------------------------------------------------
# 5. ROTATE
# ---------------------------------------------------------------------------


class Rotate(ActionPrimitive):
    primitive_id = "ROTATE"
    description = "Rotate end-effector around a specified axis"

    def generate_waypoints(
        self, params: dict[str, Any], scene: SceneState
    ) -> list[Waypoint]:
        axis: str = params["axis"]
        degrees: float = float(params["degrees"])
        rads = math.radians(degrees)

        roll, pitch, yaw = 0.0, 0.0, 0.0
        if axis == "x":
            roll = rads
        elif axis == "y":
            yaw = rads
        elif axis == "z":
            pitch = rads

        # Interpolate in steps for smooth animation
        steps = max(2, int(abs(degrees) / 15))
        waypoints: list[Waypoint] = []
        for i in range(1, steps + 1):
            t = i / steps
            waypoints.append(
                Waypoint(
                    x=scene.end_effector[0],
                    y=scene.end_effector[1],
                    z=scene.end_effector[2],
                    roll=roll * t,
                    pitch=pitch * t,
                    yaw=yaw * t,
                    gripper_open=scene.gripper_open,
                )
            )
        return waypoints

    def validate(
        self, waypoints: list[Waypoint], scene: SceneState
    ) -> ValidationResult:
        max_angular_vel = math.radians(90)  # 90 deg/s limit
        for i in range(1, len(waypoints)):
            prev = waypoints[i - 1]
            curr = waypoints[i]
            for attr in ("roll", "pitch", "yaw"):
                delta = abs(getattr(curr, attr) - getattr(prev, attr))
                if delta > max_angular_vel:
                    return ValidationResult(
                        ValidationStatus.FAIL,
                        f"Angular velocity exceeded on {attr} at waypoint {i}",
                        "max_angular_velocity",
                        i,
                    )
        return ValidationResult(ValidationStatus.PASS, "Rotation valid")

    def describe(self, params: dict[str, Any] | None = None) -> str:
        if params:
            return f"Rotating {params.get('degrees', '?')}° around {params.get('axis', '?')}-axis"
        return "Rotating end-effector"


# ---------------------------------------------------------------------------
# 6. PLACE
# ---------------------------------------------------------------------------


class Place(ActionPrimitive):
    primitive_id = "PLACE"
    description = "Place held object at a target location"

    def generate_waypoints(
        self, params: dict[str, Any], scene: SceneState
    ) -> list[Waypoint]:
        if "position" in params:
            pos = params["position"]
            target = (float(pos[0]), float(pos[1]), float(pos[2]))
        elif "target" in params:
            obj = self._get_object(scene, params["target"])
            # Place on top of target object
            obj_height = obj.size[1] if len(obj.size) > 1 else obj.size[0]
            target = (obj.position[0], obj.position[1] + obj_height / 2 + 0.05, obj.position[2])
        else:
            target = (scene.end_effector[0], scene.table_height + 0.05, scene.end_effector[2])

        gentle = params.get("gentle", True)
        safe_y = max(scene.table_height + 0.4, target[1] + 0.2)

        # Move above placement, descend gently, release
        wp_above = Waypoint(x=target[0], y=safe_y, z=target[2], gripper_open=False)

        descent_y = target[1] + (0.02 if gentle else 0.05)
        wp_place = Waypoint(x=target[0], y=descent_y, z=target[2], gripper_open=False)
        wp_release = Waypoint(x=target[0], y=descent_y, z=target[2], gripper_open=True)

        # Retreat upward
        wp_retreat = Waypoint(x=target[0], y=safe_y, z=target[2], gripper_open=True)

        return [wp_above, wp_place, wp_release, wp_retreat]

    def validate(
        self, waypoints: list[Waypoint], scene: SceneState
    ) -> ValidationResult:
        if scene.held_object_id is None:
            return ValidationResult(
                ValidationStatus.FAIL,
                "Cannot place — no object held",
                "no_object_held",
            )
        for i, wp in enumerate(waypoints):
            if wp.y < scene.table_height - 0.01:
                return ValidationResult(
                    ValidationStatus.FAIL,
                    f"Placement waypoint {i} below table",
                    "table_collision",
                    i,
                )
        return ValidationResult(ValidationStatus.PASS, "Placement valid")

    def describe(self, params: dict[str, Any] | None = None) -> str:
        if params and "target" in params:
            return f"Placing object on {params['target']}"
        if params and "position" in params:
            p = params["position"]
            return f"Placing object at ({p[0]:.2f}, {p[1]:.2f}, {p[2]:.2f})"
        return "Placing object"


# ---------------------------------------------------------------------------
# 7. PUSH
# ---------------------------------------------------------------------------


class Push(ActionPrimitive):
    primitive_id = "PUSH"
    description = "Push an object along a direction"

    def generate_waypoints(
        self, params: dict[str, Any], scene: SceneState
    ) -> list[Waypoint]:
        target_id: str = params["target"]
        direction = params["direction"]
        distance: float = float(params["distance"])
        obj = self._get_object(scene, target_id)

        # Normalize direction
        mag = math.sqrt(sum(d * d for d in direction))
        if mag < 1e-6:
            raise ValueError("Push direction vector has zero magnitude")
        norm_dir = [d / mag for d in direction]

        # Approach from opposite side of push direction
        approach_offset = 0.08
        wp_approach = Waypoint(
            x=obj.position[0] - norm_dir[0] * approach_offset,
            y=obj.position[1],
            z=obj.position[2] - norm_dir[2] * approach_offset,
            gripper_open=False,
        )

        # Contact point
        wp_contact = Waypoint(
            x=obj.position[0],
            y=obj.position[1],
            z=obj.position[2],
            gripper_open=False,
        )

        # Push through
        wp_push = Waypoint(
            x=obj.position[0] + norm_dir[0] * distance,
            y=obj.position[1] + norm_dir[1] * distance,
            z=obj.position[2] + norm_dir[2] * distance,
            gripper_open=False,
        )

        # Retract
        wp_retract = Waypoint(
            x=obj.position[0] + norm_dir[0] * distance,
            y=obj.position[1] + 0.15,
            z=obj.position[2] + norm_dir[2] * distance,
            gripper_open=True,
        )

        return [wp_approach, wp_contact, wp_push, wp_retract]

    def validate(
        self, waypoints: list[Waypoint], scene: SceneState
    ) -> ValidationResult:
        for i, wp in enumerate(waypoints):
            if wp.y < scene.table_height - 0.01:
                return ValidationResult(
                    ValidationStatus.FAIL,
                    f"Push waypoint {i} below table",
                    "table_collision",
                    i,
                )
        return ValidationResult(ValidationStatus.PASS, "Push trajectory valid")

    def describe(self, params: dict[str, Any] | None = None) -> str:
        if params:
            return f"Pushing {params.get('target', 'object')} {params.get('distance', '?')}m"
        return "Pushing object"


# ---------------------------------------------------------------------------
# 8. POUR
# ---------------------------------------------------------------------------


class Pour(ActionPrimitive):
    primitive_id = "POUR"
    description = "Tilt a grasped container to pour contents"

    def generate_waypoints(
        self, params: dict[str, Any], scene: SceneState
    ) -> list[Waypoint]:
        target_container: str = params["target_container"]
        angle: float = float(params.get("angle", 90))
        container = self._get_object(scene, target_container)

        # Position above the target container
        pour_x = container.position[0]
        pour_z = container.position[2]
        pour_y = container.position[1] + 0.3

        wp_position = Waypoint(
            x=pour_x, y=pour_y, z=pour_z, gripper_open=False
        )

        # Tilt gradually
        steps = max(3, int(angle / 20))
        tilt_wps: list[Waypoint] = []
        for i in range(1, steps + 1):
            t = i / steps
            tilt_wps.append(
                Waypoint(
                    x=pour_x,
                    y=pour_y,
                    z=pour_z,
                    roll=math.radians(angle * t),
                    gripper_open=False,
                )
            )

        # Hold pour position
        wp_hold = Waypoint(
            x=pour_x,
            y=pour_y,
            z=pour_z,
            roll=math.radians(angle),
            gripper_open=False,
        )

        # Return to upright
        wp_upright = Waypoint(
            x=pour_x, y=pour_y, z=pour_z, gripper_open=False
        )

        return [wp_position, *tilt_wps, wp_hold, wp_upright]

    def validate(
        self, waypoints: list[Waypoint], scene: SceneState
    ) -> ValidationResult:
        if scene.held_object_id is None:
            return ValidationResult(
                ValidationStatus.FAIL,
                "Cannot pour — no container held",
                "no_object_held",
            )
        return ValidationResult(ValidationStatus.PASS, "Pour trajectory valid")

    def describe(self, params: dict[str, Any] | None = None) -> str:
        if params:
            angle = params.get("angle", 90)
            target = params.get("target_container", "container")
            return f"Pouring into {target} at {angle}°"
        return "Pouring"


# ---------------------------------------------------------------------------
# 9. STACK
# ---------------------------------------------------------------------------


class Stack(ActionPrimitive):
    primitive_id = "STACK"
    description = "Place held object on top of a target object"

    def generate_waypoints(
        self, params: dict[str, Any], scene: SceneState
    ) -> list[Waypoint]:
        target_id: str = params["target"]
        obj = self._get_object(scene, target_id)

        obj_height = obj.size[1] if len(obj.size) > 1 else obj.size[0]
        stack_y = obj.position[1] + obj_height / 2 + 0.05
        safe_y = stack_y + 0.25

        # Move above target
        wp_above = Waypoint(
            x=obj.position[0], y=safe_y, z=obj.position[2], gripper_open=False
        )

        # Descend to stack position
        wp_stack = Waypoint(
            x=obj.position[0], y=stack_y, z=obj.position[2], gripper_open=False
        )

        # Release
        wp_release = Waypoint(
            x=obj.position[0], y=stack_y, z=obj.position[2], gripper_open=True
        )

        # Retreat
        wp_retreat = Waypoint(
            x=obj.position[0], y=safe_y, z=obj.position[2], gripper_open=True
        )

        return [wp_above, wp_stack, wp_release, wp_retreat]

    def validate(
        self, waypoints: list[Waypoint], scene: SceneState
    ) -> ValidationResult:
        if scene.held_object_id is None:
            return ValidationResult(
                ValidationStatus.FAIL,
                "Cannot stack — no object held",
                "no_object_held",
            )
        return ValidationResult(ValidationStatus.PASS, "Stack trajectory valid")

    def describe(self, params: dict[str, Any] | None = None) -> str:
        if params:
            return f"Stacking object on {params.get('target', 'target')}"
        return "Stacking object"


# ---------------------------------------------------------------------------
# 10. SORT
# ---------------------------------------------------------------------------


class Sort(ActionPrimitive):
    primitive_id = "SORT"
    description = "Arrange multiple objects by a criterion"

    def generate_waypoints(
        self, params: dict[str, Any], scene: SceneState
    ) -> list[Waypoint]:
        object_ids: list[str] = params["objects"]
        criterion: str = params.get("criterion", "position")
        direction: str = params.get("direction", "left_to_right")

        objects = [self._get_object(scene, oid) for oid in object_ids]

        # Sort objects by criterion
        if criterion == "color":
            color_order = {"red": 0, "green": 1, "blue": 2, "yellow": 3, "purple": 4, "orange": 5}
            objects.sort(key=lambda o: color_order.get(o.color.lower(), 99))
        elif criterion == "size":
            objects.sort(key=lambda o: o.size[0] if o.size else 0)
        else:
            objects.sort(key=lambda o: o.position[0])

        if direction in ("right_to_left", "back_to_front"):
            objects.reverse()

        # Generate placement positions in a line
        spacing = 0.3
        start_x = -spacing * (len(objects) - 1) / 2
        place_y = scene.table_height + 0.1

        waypoints: list[Waypoint] = []
        for i, obj in enumerate(objects):
            if direction in ("left_to_right", "right_to_left"):
                place_x = start_x + i * spacing
                place_z = 0.0
            else:
                place_x = 0.0
                place_z = start_x + i * spacing

            # Approach, pick, transport, place for each object
            safe_y = scene.table_height + 0.4
            waypoints.extend([
                Waypoint(x=obj.position[0], y=safe_y, z=obj.position[2], gripper_open=True),
                Waypoint(x=obj.position[0], y=obj.position[1], z=obj.position[2], gripper_open=True),
                Waypoint(x=obj.position[0], y=obj.position[1], z=obj.position[2], gripper_open=False),
                Waypoint(x=obj.position[0], y=safe_y, z=obj.position[2], gripper_open=False),
                Waypoint(x=place_x, y=safe_y, z=place_z, gripper_open=False),
                Waypoint(x=place_x, y=place_y, z=place_z, gripper_open=False),
                Waypoint(x=place_x, y=place_y, z=place_z, gripper_open=True),
                Waypoint(x=place_x, y=safe_y, z=place_z, gripper_open=True),
            ])

        return waypoints

    def validate(
        self, waypoints: list[Waypoint], scene: SceneState
    ) -> ValidationResult:
        for i, wp in enumerate(waypoints):
            if wp.y < scene.table_height - 0.01:
                return ValidationResult(
                    ValidationStatus.FAIL,
                    f"Sort waypoint {i} below table",
                    "table_collision",
                    i,
                )
        return ValidationResult(ValidationStatus.PASS, "Sort trajectory valid")

    def describe(self, params: dict[str, Any] | None = None) -> str:
        if params:
            criterion = params.get("criterion", "position")
            direction = params.get("direction", "left to right")
            return f"Sorting objects by {criterion}, {direction.replace('_', ' ')}"
        return "Sorting objects"


# ---------------------------------------------------------------------------
# 11. INSPECT
# ---------------------------------------------------------------------------


class Inspect(ActionPrimitive):
    primitive_id = "INSPECT"
    description = "Move to observe a target for VLM scene capture"

    def generate_waypoints(
        self, params: dict[str, Any], scene: SceneState
    ) -> list[Waypoint]:
        target_id: str = params["target"]
        distance: float = float(params.get("distance", 0.15))
        obj = self._get_object(scene, target_id)

        # Position above and slightly back from the target
        inspect_y = obj.position[1] + distance + 0.1
        inspect_z = obj.position[2] - distance

        wp_move = Waypoint(
            x=obj.position[0],
            y=inspect_y,
            z=inspect_z,
            pitch=math.radians(-30),  # Look down at object
            gripper_open=True,
        )

        # Hold for capture
        wp_hold = Waypoint(
            x=obj.position[0],
            y=inspect_y,
            z=inspect_z,
            pitch=math.radians(-30),
            gripper_open=True,
        )

        return [wp_move, wp_hold]

    def validate(
        self, waypoints: list[Waypoint], scene: SceneState
    ) -> ValidationResult:
        for i, wp in enumerate(waypoints):
            if wp.y < scene.table_height:
                return ValidationResult(
                    ValidationStatus.FAIL,
                    f"Inspect position {i} below table",
                    "table_collision",
                    i,
                )
        return ValidationResult(ValidationStatus.PASS, "Inspect position valid")

    def describe(self, params: dict[str, Any] | None = None) -> str:
        if params:
            return f"Inspecting {params.get('target', 'target')}"
        return "Inspecting scene"


# ---------------------------------------------------------------------------
# 12. WAIT
# ---------------------------------------------------------------------------


class Wait(ActionPrimitive):
    primitive_id = "WAIT"
    description = "Pause execution for a duration or condition"

    def generate_waypoints(
        self, params: dict[str, Any], scene: SceneState
    ) -> list[Waypoint]:
        duration_ms: float = float(params.get("duration_ms", 1000))
        # A wait produces a single waypoint at current position with metadata
        wp = Waypoint(
            x=scene.end_effector[0],
            y=scene.end_effector[1],
            z=scene.end_effector[2],
            gripper_open=scene.gripper_open,
        )
        return [wp]

    def validate(
        self, waypoints: list[Waypoint], scene: SceneState
    ) -> ValidationResult:
        return ValidationResult(ValidationStatus.PASS, "Wait is always valid")

    def describe(self, params: dict[str, Any] | None = None) -> str:
        if params:
            duration = params.get("duration_ms", 1000)
            condition = params.get("condition")
            if condition:
                return f"Waiting for {condition}"
            return f"Waiting {duration}ms"
        return "Waiting"


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

PRIMITIVE_REGISTRY: dict[str, ActionPrimitive] = {
    "APPROACH": Approach(),
    "GRASP": Grasp(),
    "RELEASE": Release(),
    "TRANSLATE": Translate(),
    "ROTATE": Rotate(),
    "PLACE": Place(),
    "PUSH": Push(),
    "POUR": Pour(),
    "STACK": Stack(),
    "SORT": Sort(),
    "INSPECT": Inspect(),
    "WAIT": Wait(),
}


def get_primitive(action_id: str) -> ActionPrimitive:
    """Retrieve a primitive by ID. Raises KeyError if not found."""
    prim = PRIMITIVE_REGISTRY.get(action_id.upper())
    if prim is None:
        raise KeyError(
            f"Unknown action primitive '{action_id}'. "
            f"Available: {list(PRIMITIVE_REGISTRY.keys())}"
        )
    return prim
