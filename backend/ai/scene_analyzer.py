"""
KINESYS — Scene Analyzer

Generates a structured scene graph from the Three.js frontend state,
received via WebSocket. For now, this processes the JSON state directly
rather than using a VLM — VLM integration will be added in a later task.

The scene graph provides:
  - Object inventory (id, shape, color, position, size)
  - Spatial relationships (above, below, left_of, right_of, near, on_top_of)
  - Natural language description for the LLM system prompt
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from core.action_primitives import SceneObject, SceneState

# ---------------------------------------------------------------------------
# Spatial relationship types
# ---------------------------------------------------------------------------

NEAR_THRESHOLD = 0.3  # meters
ON_TOP_THRESHOLD = 0.15  # vertical proximity for "on top of"
HORIZONTAL_THRESHOLD = 0.1  # horizontal proximity for "on top of"


@dataclass
class SpatialRelation:
    """A spatial relationship between two objects."""

    subject: str
    relation: str
    object: str

    def to_natural_language(self) -> str:
        return f"{self.subject} is {self.relation.replace('_', ' ')} {self.object}"


@dataclass
class SceneGraph:
    """Complete scene graph with objects and spatial relationships."""

    objects: list[SceneObject]
    relations: list[SpatialRelation]
    table_height: float
    end_effector: tuple[float, float, float]
    gripper_open: bool
    held_object_id: str | None

    def to_description(self) -> str:
        """Generate a natural language scene description for the LLM prompt."""
        lines: list[str] = []

        lines.append("## Objects on the table:")
        for obj in self.objects:
            pos = obj.position
            size_str = " x ".join(f"{s:.2f}" for s in obj.size)
            held = " [CURRENTLY HELD BY ROBOT]" if obj.is_held else ""
            lines.append(
                f"- {obj.id}: {obj.color} {obj.shape}, "
                f"position=({pos[0]:.2f}, {pos[1]:.2f}, {pos[2]:.2f}), "
                f"size=({size_str}){held}"
            )

        if self.relations:
            lines.append("\n## Spatial relationships:")
            for rel in self.relations:
                lines.append(f"- {rel.to_natural_language()}")

        lines.append(f"\n## Robot state:")
        lines.append(
            f"- End-effector at ({self.end_effector[0]:.2f}, "
            f"{self.end_effector[1]:.2f}, {self.end_effector[2]:.2f})"
        )
        lines.append(f"- Gripper: {'open' if self.gripper_open else 'closed'}")
        if self.held_object_id:
            lines.append(f"- Holding: {self.held_object_id}")

        lines.append(f"\n## Table surface at y={self.table_height:.2f}")

        return "\n".join(lines)

    def to_dict(self) -> dict[str, Any]:
        return {
            "objects": [
                {
                    "id": o.id,
                    "shape": o.shape,
                    "color": o.color,
                    "position": list(o.position),
                    "size": list(o.size),
                    "is_held": o.is_held,
                }
                for o in self.objects
            ],
            "relations": [
                {"subject": r.subject, "relation": r.relation, "object": r.object}
                for r in self.relations
            ],
            "robot": {
                "end_effector": list(self.end_effector),
                "gripper_open": self.gripper_open,
                "held_object_id": self.held_object_id,
            },
            "table_height": self.table_height,
        }


# ---------------------------------------------------------------------------
# Scene analysis
# ---------------------------------------------------------------------------


def compute_spatial_relations(objects: list[SceneObject]) -> list[SpatialRelation]:
    """Compute pairwise spatial relationships between scene objects."""
    relations: list[SpatialRelation] = []

    for i, a in enumerate(objects):
        for j, b in enumerate(objects):
            if i == j:
                continue

            dx = a.position[0] - b.position[0]
            dy = a.position[1] - b.position[1]
            dz = a.position[2] - b.position[2]
            horiz_dist = math.sqrt(dx * dx + dz * dz)
            dist_3d = math.sqrt(dx * dx + dy * dy + dz * dz)

            # On top of
            if dy > ON_TOP_THRESHOLD * 0.5 and horiz_dist < HORIZONTAL_THRESHOLD:
                relations.append(SpatialRelation(a.id, "on_top_of", b.id))

            # Near
            elif dist_3d < NEAR_THRESHOLD:
                # Avoid duplicate "near" — only add if a.id < b.id
                if a.id < b.id:
                    relations.append(SpatialRelation(a.id, "near", b.id))

            # Left / right (x-axis)
            if dx < -NEAR_THRESHOLD:
                relations.append(SpatialRelation(a.id, "left_of", b.id))
            elif dx > NEAR_THRESHOLD:
                relations.append(SpatialRelation(a.id, "right_of", b.id))

            # In front / behind (z-axis)
            if dz < -NEAR_THRESHOLD:
                relations.append(SpatialRelation(a.id, "in_front_of", b.id))
            elif dz > NEAR_THRESHOLD:
                relations.append(SpatialRelation(a.id, "behind", b.id))

    return relations


def analyze_scene(scene: SceneState) -> SceneGraph:
    """Build a complete scene graph from the current scene state."""
    objects = list(scene.objects.values())
    relations = compute_spatial_relations(objects)

    return SceneGraph(
        objects=objects,
        relations=relations,
        table_height=scene.table_height,
        end_effector=scene.end_effector,
        gripper_open=scene.gripper_open,
        held_object_id=scene.held_object_id,
    )


def scene_state_from_frontend(data: dict[str, Any]) -> SceneState:
    """
    Parse a scene state from the frontend WebSocket message.

    Expected format:
    {
        "objects": [
            {"id": "red_cube", "shape": "box", "color": "#ef4444",
             "position": [x, y, z], "size": [w, h, d], "mass": 0.5}
        ],
        "end_effector": [x, y, z],
        "gripper_open": true,
        "held_object_id": null,
        "table_height": 0.5
    }
    """
    objects: dict[str, SceneObject] = {}

    for obj_data in data.get("objects", []):
        obj_id = obj_data["id"]
        objects[obj_id] = SceneObject(
            id=obj_id,
            shape=obj_data.get("shape", "box"),
            color=obj_data.get("color", "unknown"),
            position=tuple(obj_data.get("position", [0, 0, 0])),
            size=tuple(obj_data.get("size", [0.1])),
            mass=obj_data.get("mass", 0.0),
            is_held=obj_data.get("is_held", False),
        )

    ee = data.get("end_effector", [0.0, 1.5, 0.0])

    return SceneState(
        objects=objects,
        end_effector=tuple(ee),
        gripper_open=data.get("gripper_open", True),
        held_object_id=data.get("held_object_id"),
        table_height=data.get("table_height", 0.5),
    )
