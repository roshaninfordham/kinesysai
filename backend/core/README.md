# backend/core — Robot Execution Engine

The core engine converts abstract AI-generated action plans into validated, physically-safe waypoint trajectories. It is pure Python with no external AI dependencies — deliberately isolated so it can be tested and verified independently of any LLM.

---

## Module Map

```
core/
├── action_primitives.py  ← 12 ActionPrimitive classes + PRIMITIVE_REGISTRY
├── trajectory_planner.py ← Action list → TrajectoryPlan (waypoints + validation)
├── safety_validator.py   ← Hard constraint checker (velocity, bounds, collision)
└── state_machine.py      ← LangGraph pipeline definition
```

---

## action_primitives.py — The 12 Primitives

Every robot task is expressed as a sequence of **ActionPrimitive** instances. Each primitive:
1. **`generate_waypoints(params, scene)`** — computes a list of `Waypoint` objects
2. **`validate(waypoints, scene)`** — checks primitive-specific safety rules
3. **`describe(params)`** — returns a human-readable sentence for TTS narration

### Data Structures

```python
@dataclass(frozen=True)
class Waypoint:
    x: float            # end-effector X position (meters)
    y: float            # end-effector Y position (height)
    z: float            # end-effector Z position (meters)
    roll: float = 0.0   # rotation around X axis (radians)
    pitch: float = 0.0  # rotation around Y axis (radians)
    yaw: float = 0.0    # rotation around Z axis (radians)
    gripper_open: bool = True

@dataclass
class SceneObject:
    id: str
    shape: str                      # "box" | "cylinder" | "sphere"
    color: str
    position: tuple[float, float, float]
    size: tuple[float, ...]         # [w, h, d] for box, [r, h] for cylinder, [r] for sphere
    mass: float = 0.0
    is_held: bool = False

@dataclass
class SceneState:
    objects: dict[str, SceneObject]
    end_effector: tuple[float, float, float] = (0.0, 1.5, 0.0)
    gripper_open: bool = True
    held_object_id: str | None = None
    table_height: float = 0.5
```

### The 12 Primitives

#### 1. `APPROACH` — Move near a target
```
Parameters: target (str), offset (vec3, default [0, 0.05, 0])
Waypoints:  1. Lift to safe height
            2. Move horizontally above target
            3. Descend to offset position
Validates:  No waypoint below table surface
```

#### 2. `GRASP` — Close gripper on target
```
Parameters: target (str), force (float 0-1)
Waypoints:  1. Move to object center (gripper open)
            2. Close gripper at same position
Validates:  Gripper must not already be holding an object
```

#### 3. `RELEASE` — Open gripper
```
Parameters: (none required)
Waypoints:  1. Open gripper at current position
Validates:  Warns (not fails) if nothing is held
```

#### 4. `TRANSLATE` — Move to position
```
Parameters: position (vec3) OR delta (vec3)
Waypoints:  1. Lift to safe height
            2. Move laterally to target X/Z
            3. Descend to target Y
Validates:  No waypoint below table surface
```

#### 5. `ROTATE` — Rotate end-effector
```
Parameters: axis ("x"|"y"|"z"), degrees (float)
Waypoints:  N interpolated steps (1 per 15°)
Validates:  Angular velocity ≤ 90°/s per step
```

#### 6. `PLACE` — Place held object
```
Parameters: position (vec3) OR target (str, places on top of target)
Waypoints:  1. Move above placement position
            2. Gentle descent
            3. Release gripper
            4. Retreat upward
Validates:  Object must be held; no waypoint below table
```

#### 7. `PUSH` — Push object along direction
```
Parameters: target (str), direction (vec3), distance (float)
Waypoints:  1. Approach from opposite side
            2. Contact point
            3. Push through distance
            4. Retract upward
Validates:  No waypoint below table
```

#### 8. `POUR` — Tilt container to pour
```
Parameters: target_container (str), angle (float, default 90°)
Waypoints:  1. Position above container
            2. N tilt steps (1 per 20°)
            3. Hold pour position
            4. Return to upright
Validates:  Object must be held
```

#### 9. `STACK` — Place on top of object
```
Parameters: target (str)
Waypoints:  1. Move above target (at stack height + margin)
            2. Descend to stack position
            3. Release gripper
            4. Retreat upward
Validates:  Object must be held
Stack height = target.position.y + target.size.y/2 + 0.05m
```

#### 10. `SORT` — Arrange objects by criterion
```
Parameters: objects (list[str]), criterion ("color"|"size"|"position"), direction
Waypoints:  Per-object: approach → pick → transport → place
            Objects placed in a line with 0.3m spacing
Validates:  No waypoint below table
```

#### 11. `INSPECT` — Observe a target
```
Parameters: target (str), distance (float, default 0.15m)
Waypoints:  1. Position above and slightly back from target
            2. Hold position (for VLM capture)
            pitch = -30° (looking down)
Validates:  Position must be above table
```

#### 12. `WAIT` — Pause execution
```
Parameters: duration_ms (int, default 1000), condition (str, optional)
Waypoints:  1. Single waypoint at current position (no motion)
Validates:  Always passes
```

### PRIMITIVE_REGISTRY

```python
PRIMITIVE_REGISTRY: dict[str, ActionPrimitive] = {
    "APPROACH": Approach(),
    "GRASP": Grasp(),
    # ... all 12
}

# Usage
primitive = get_primitive("STACK")   # raises KeyError if not found
waypoints = primitive.generate_waypoints({"target": "blue_cylinder"}, scene)
result = primitive.validate(waypoints, scene)
narration = primitive.describe({"target": "blue_cylinder"})
# → "Stacking object on blue_cylinder"
```

---

## trajectory_planner.py — Action List → TrajectoryPlan

Iterates over an action plan, generates waypoints for each primitive, validates them, and tracks evolving scene state so later primitives see the effects of earlier ones.

### `plan_trajectory(actions, scene, safety_config) → TrajectoryPlan`

```
For each action in actions:
    1. Resolve primitive from PRIMITIVE_REGISTRY
    2. primitive.generate_waypoints(params, current_scene)
    3. primitive.validate(waypoints, current_scene)
       └─► FAIL: return TrajectoryPlan(is_valid=False, error=...)
    4. Append waypoints to all_waypoints
    5. _update_scene_after_action(current_scene, action_id, waypoints)
       └─► Updates: end_effector, gripper_open, held_object_id, object.is_held

After all actions:
    validate_trajectory(all_waypoints, scene, safety_config)
    └─► Full-trajectory safety check (velocity, bounds, distance)
```

### Scene State Evolution

The planner tracks how each action changes the scene, so later primitives compute correct waypoints:

| Action | Scene change |
|--------|-------------|
| `GRASP` | `held_object_id = target`, `object.is_held = True`, `gripper_open = False` |
| `RELEASE` | `held_object_id = None`, `object.is_held = False`, `gripper_open = True` |
| `PLACE` / `STACK` | Object position updated to release waypoint, `held_object_id = None` |
| Any | `end_effector` updated to last waypoint position |

### `TrajectoryPlan`

```python
@dataclass
class TrajectoryPlan:
    steps: list[ActionStep]           # per-action breakdown
    all_waypoints: list[Waypoint]     # flat list for execution
    safety_result: SafetyValidationResult
    narration_sequence: list[str]     # TTS strings
    is_valid: bool
    error: str | None
```

---

## safety_validator.py — Hard Constraint Engine

Runs 5 independent constraint checks on the full waypoint sequence. Any `error`-severity violation makes the trajectory unsafe.

### `SafetyConfig` (defaults)

```python
@dataclass
class SafetyConfig:
    workspace: WorkspaceBounds        # x/y/z min/max
    table_height: float = 0.5         # table surface Y
    table_collision_margin: float = 0.01
    max_linear_velocity_mps: float = 2.5    # max speed between waypoints
    max_angular_velocity_dps: float = 180.0 # max rotation speed
    max_gripper_force_n: float = 20.0
    min_obstacle_clearance_m: float = 0.02  # soft constraint (warning only)
    max_waypoint_distance_m: float = 3.0    # max single-step distance
    assumed_dt: float = 2.0                 # seconds per waypoint step
```

### Constraint Checks

```
validate_trajectory(waypoints, scene, config)
    │
    ├── check_workspace_bounds()    ERROR if any wp outside X/Y/Z box
    ├── check_table_collision()     ERROR if any wp.y < table_height - margin
    ├── check_linear_velocity()     ERROR if dist/assumed_dt > max_linear_velocity
    │     velocity = sqrt(dx²+dy²+dz²) / assumed_dt
    │     e.g. 1.4m move in 2.0s = 0.7 m/s → OK (< 2.5 m/s limit)
    ├── check_angular_velocity()    ERROR if angle_delta/assumed_dt > max_angular
    ├── check_waypoint_distance()   ERROR if single move > max_waypoint_distance
    └── check_obstacle_clearance()  WARNING only (not error) if near object
    │
    ▼
SafetyValidationResult(is_safe, violations, warnings, summary)
```

### Velocity Calculation

```
waypoint[i-1] → waypoint[i]

dx = curr.x - prev.x
dy = curr.y - prev.y
dz = curr.z - prev.z
distance = sqrt(dx² + dy² + dz²)
velocity = distance / assumed_dt   (assumed_dt = 2.0s)

if velocity > 2.5 m/s → VIOLATION
```

---

## state_machine.py — LangGraph Pipeline

Defines the full AI-to-execution pipeline as a directed graph using **LangGraph**.

### State Schema (`PipelineState`)

```python
class PipelineState(TypedDict, total=False):
    # Input
    transcript: str
    scene_data: dict

    # Intermediate
    action_plan: list[dict]
    trajectory_plan: dict
    waypoints: list[dict]
    narration: list[str]

    # Validation
    validation_result: dict
    is_safe: bool
    requires_confirmation: bool
    confirmation_reason: str
    human_confirmation_granted: bool

    # Flow
    current_node: str
    error_message: str | None
    final_state: str
```

### Node Functions

| Node | Function | Description |
|------|----------|-------------|
| `IDLE` | `idle_node` | Reset state, preserve pre-computed fields |
| `LISTENING` | `listening_node` | Validate transcript is non-empty |
| `DECOMPOSING` | `decomposing_node` | Validate pre-populated action_plan (LLM called async in main.py) |
| `SCENE_ANALYZING` | `scene_analyzing_node` | Build SceneGraph, add description to state |
| `PLANNING` | `planning_node` | Call `plan_trajectory()`, store waypoints |
| `VALIDATING` | `validating_node` | Run `validate_trajectory()`, check HITL conditions |
| `EXECUTING` | `executing_node` | Mark execution ready, bundle response |
| `CONFIRMING` | `confirming_node` | Mark task complete |
| `ERROR` | `error_node` | Log error, prepare recovery |

### HITL Gate (Human-in-the-Loop)

After `VALIDATING`, the pipeline checks two conditions before allowing execution:

```python
HITL_WAYPOINT_THRESHOLD = 5    # > 5 waypoints → require confirmation
HITL_VELOCITY_FRACTION = 0.8   # velocity > 80% of max → require confirmation

# HITL triggered if:
# len(waypoints) > 5
# OR any step velocity > 0.8 * 2.5 = 2.0 m/s
```

If HITL is triggered and `human_confirmation_granted = False`, the pipeline sends a `hitl_required` WebSocket message and waits. On `hitl_confirm` response, the graph resumes.

### Graph Edges

```
IDLE → LISTENING → DECOMPOSING → SCENE_ANALYZING → PLANNING → VALIDATING
VALIDATING → EXECUTING  (if safe and no HITL)
VALIDATING → EXECUTING  (if safe and HITL confirmed)
VALIDATING → ERROR      (if unsafe)
EXECUTING  → CONFIRMING → IDLE
ERROR      → IDLE
```
