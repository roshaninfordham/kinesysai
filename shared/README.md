# shared — Cross-Boundary Schema Definitions

This directory contains **canonical definitions** shared between the frontend and backend. It is the single source of truth for the robot action primitive library — any change here should be reflected in both `backend/core/action_primitives.py` and the frontend UI.

---

## Contents

```
shared/
└── action_types.json    ← Complete action primitive schemas with parameters,
                           preconditions, postconditions, and safety constraints
```

---

## action_types.json

Defines all **12 action primitives** with their full parameter schemas, pre/postconditions, and per-primitive safety limits.

### Schema

```jsonc
{
  "version": "1.0.0",
  "description": "...",
  "primitives": {
    "PRIMITIVE_ID": {
      "id": "string",
      "description": "string",
      "parameters": {
        "param_name": {
          "type": "string | number | boolean | vec3 | array",
          "required": true | false,
          "default": "...",
          "description": "string"
          // numbers also have: "min", "max"
          // strings also have: "enum" (list of valid values)
        }
      },
      "preconditions": ["condition1", "condition2"],
      "postconditions": ["condition1", "condition2"],
      "safety": {
        "collision_check": true | false,
        "max_velocity_mps": number,      // where applicable
        "max_force_n": number,           // where applicable
        "stability_check": true | false  // where applicable
      }
    }
  }
}
```

### Quick Reference

| Primitive | Key Parameters | Preconditions | Postconditions |
|-----------|---------------|---------------|----------------|
| `APPROACH` | `target`, `offset`, `speed` | `target_visible`, `path_clear` | `near_target` |
| `GRASP` | `target`, `force`, `width` | `near_target`, `gripper_open` | `object_grasped` |
| `RELEASE` | `speed` | `object_grasped` | `gripper_open`, `object_placed` |
| `TRANSLATE` | `position` or `delta`, `speed` | `path_clear` | `at_position` |
| `ROTATE` | `axis`, `degrees`, `speed` | — | `at_orientation` |
| `PLACE` | `position` or `target`, `gentle` | `object_grasped` | `gripper_open`, `object_placed` |
| `PUSH` | `target`, `direction`, `distance`, `force` | `near_target`, `path_clear` | `object_displaced` |
| `POUR` | `target_container`, `angle`, `speed` | `object_grasped`, `target_visible` | `contents_transferred` |
| `STACK` | `target`, `alignment`, `offset_z` | `object_grasped`, `target_visible` | `object_stacked`, `gripper_open` |
| `SORT` | `objects[]`, `criterion`, `direction` | `objects_visible` | `objects_sorted` |
| `INSPECT` | `target`, `distance`, `capture_image` | `target_visible` | `scene_analyzed` |
| `WAIT` | `duration_ms`, `condition` | — | `wait_complete` |

### Parameter Types

| Type | Format | Example |
|------|--------|---------|
| `string` | Plain string | `"red_cube"` |
| `number` | Float | `0.5` |
| `boolean` | Bool | `true` |
| `vec3` | `[x, y, z]` array | `[0.0, 0.05, 0.0]` |
| `array` of string | String array | `["red_cube", "blue_cylinder"]` |

### Safety Fields

| Field | Applies to | Description |
|-------|-----------|-------------|
| `collision_check` | most primitives | Whether backend runs collision check for this primitive's waypoints |
| `max_velocity_mps` | APPROACH, TRANSLATE | Per-primitive velocity limit (stricter than global 2.5 m/s) |
| `max_force_n` | GRASP, PUSH | Maximum force allowed |
| `max_angular_velocity_dps` | ROTATE | Per-primitive angular velocity limit |
| `height_check` | RELEASE | Ensures release height is safe |
| `descent_speed_mps` | PLACE | Slow final descent speed |
| `spill_check` | POUR | Detects potential spills |
| `stability_check` | STACK | Checks stack stability after placement |
| `timeout_ms` | WAIT | Maximum wait duration |

---

## Usage

### Backend (Python)

The backend's `action_primitives.py` implements each primitive in this schema. `PRIMITIVE_REGISTRY` maps `primitive_id → ActionPrimitive` instance.

The `task_decomposer.py` reads the schema to build LLM prompts — it references the JSON description and parameter list to tell the LLM what actions are available.

### Frontend (TypeScript)

The frontend fetches the primitive list from `GET /api/primitives` (served by the backend which reads this file) to:
- Build the action display in `TeachPanel.tsx` (action confirmation cards)
- Validate extracted actions in `TeachPanel` before sending to backend
- Populate `SafetyPanel.tsx` with primitive-specific safety limits

### Future: Direct JSON Import

For offline use, the frontend can import `action_types.json` directly:

```typescript
import primitives from "../../shared/action_types.json";
const schema = primitives.primitives["STACK"];
```

---

## Versioning

The `"version"` field follows semantic versioning:
- **Patch** (`1.0.x`): parameter description changes, safety value tweaks
- **Minor** (`1.x.0`): new parameters (backward compatible)
- **Major** (`x.0.0`): new primitives, removed primitives, breaking changes

When bumping the version, update both this file and the implementation in `backend/core/action_primitives.py`.
