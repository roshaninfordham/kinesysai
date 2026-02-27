# backend/tests — Test Suite

156 unit tests covering the full backend. All tests are pure Python with no external dependencies — no API keys, no network, no Ollama required.

```bash
cd backend
python3 -m pytest tests/ -v                        # all tests, verbose
python3 -m pytest tests/ -q --tb=short             # compact output
python3 -m pytest tests/test_safety.py -v          # single suite
python3 -m pytest tests/ -k "velocity" -v          # filter by name
python3 -m pytest tests/ --co -q                   # list tests without running
```

---

## Test Suites

### `test_primitives.py` — 40 tests

Tests every action primitive's `generate_waypoints()` and `validate()` methods.

**What is tested:**

| Category | Tests |
|----------|-------|
| Waypoint count per primitive | Each primitive generates the correct number of waypoints |
| Gripper state transitions | GRASP closes, RELEASE opens, STACK releases at end |
| Position correctness | STACK places at correct height; APPROACH stops at correct offset |
| Parameter validation | Missing required params raise `ValueError` |
| Unknown target | `_get_object()` raises `KeyError` when target not in scene |
| Edge cases | ROTATE with 0°, WAIT with no duration, SORT with 1 object |
| Narration | `describe()` returns non-empty string for all primitives |
| PRIMITIVE_REGISTRY | All 12 IDs present; `get_primitive()` works |

**Example test structure:**
```python
def test_stack_waypoint_height():
    scene = make_scene(objects={"target": box(pos=[0, 0.6, 0], size=[0.2, 0.2, 0.2])})
    waypoints = Stack().generate_waypoints({"target": "target"}, scene)
    # stack_y = 0.6 + 0.1 + 0.05 = 0.75
    # safe_y  = 0.75 + 0.25 = 1.0
    assert waypoints[0].y == pytest.approx(1.0)  # above
    assert waypoints[1].y == pytest.approx(0.75) # stack position
    assert not waypoints[2].gripper_open == False  # gripper opens on release
    assert waypoints[3].y == pytest.approx(1.0)  # retreat
```

---

### `test_safety.py` — 36 tests

Tests every constraint checker in `safety_validator.py`.

**What is tested:**

| Constraint | Tests |
|-----------|-------|
| Workspace bounds X | Within bounds pass; outside fail; exactly at boundary pass |
| Workspace bounds Y (height) | Below table fail; above ceiling fail; within workspace pass |
| Workspace bounds Z | Same pattern as X |
| Table collision | Below `table_height - margin` fails; at table passes |
| Linear velocity | Fast moves (>2.5 m/s) fail; slow moves pass; calculated correctly |
| Angular velocity | Fast rotations (>180°/s) fail; slow rotations pass |
| Waypoint distance | Moves >3.0m fail; moves <3.0m pass |
| Obstacle clearance | Within 0.02m of object → warning only (not error) |
| Multi-violation | Multiple failing waypoints → multiple violations reported |
| Empty trajectory | No violations for empty waypoint list |
| Single waypoint | No velocity violations for single waypoint (no pairs) |
| Full validate_trajectory | Aggregates all checks; `is_safe` correct |

**Key test patterns:**
```python
def test_velocity_at_limit():
    # 2.5 m/s exactly = passes (not strictly greater)
    wps = [Waypoint(0, 0, 0), Waypoint(5.0, 0, 0)]  # 5m in 2s = 2.5 m/s
    violations = check_linear_velocity(wps)
    assert len(violations) == 0

def test_velocity_over_limit():
    # 5.1m in 2s = 2.55 m/s > 2.5 limit
    wps = [Waypoint(0, 0, 0), Waypoint(5.1, 0, 0)]
    violations = check_linear_velocity(wps)
    assert len(violations) == 1
    assert violations[0].constraint == "max_linear_velocity"
```

---

### `test_decomposer.py` — 40 tests

Tests the LLM task decomposition pipeline without making real API calls (all LLM calls are mocked).

**What is tested:**

| Category | Tests |
|----------|-------|
| Prompt construction | System prompt contains all 12 primitive names |
| Scene description injection | Scene object IDs appear in prompt |
| JSON parsing | Valid JSON parsed correctly |
| Malformed JSON handling | Retry triggered on non-JSON response |
| Unknown primitive filtering | Actions not in registry flagged |
| Required parameter validation | Missing `target` in GRASP flagged |
| Retry with error feedback | Error from attempt N injected into attempt N+1 prompt |
| Temperature escalation | retry 1: 0.1, retry 2: 0.3, retry 3: 0.6 |
| Empty action list | Returns error (LLM gave empty plan) |
| `DecompositionResult` structure | Fields `success`, `actions`, `raw` all populated |
| Complex commands | Multi-step commands produce multi-action plans |

**Mock pattern:**
```python
@pytest.fixture
def mock_llm(mocker):
    client = AsyncMock()
    client.chat.return_value = LLMResponse(
        content='[{"action":"GRASP","params":{"target":"red_cube"}}]',
        provider=LLMProvider.GROQ, model="test", usage={}, raw={}
    )
    return client
```

---

### `test_state_machine.py` — 40 tests

Tests every node in the LangGraph pipeline and the full end-to-end flow.

**What is tested:**

| Category | Tests |
|----------|-------|
| `idle_node` | Resets state; preserves pre-populated fields |
| `listening_node` | Empty transcript → error; valid transcript → DECOMPOSING |
| `decomposing_node` | Pre-populated action_plan passes through |
| `scene_analyzing_node` | Builds SceneGraph from scene_data; adds description |
| `planning_node` | Calls trajectory_planner; stores waypoints |
| `validating_node` | Safe trajectory → EXECUTING; unsafe → ERROR |
| HITL: waypoint count | >5 waypoints + no confirmation → HITL required |
| HITL: velocity | >80% max velocity + no confirmation → HITL required |
| HITL: confirmed | HITL required + confirmation granted → EXECUTING |
| ERROR node | Sets `final_state = "ERROR"`, clears pipeline state |
| ERROR → IDLE recovery | After ERROR, pipeline returns to IDLE |
| Full pipeline | IDLE → LISTENING → ... → EXECUTING in one `invoke()` call |
| Concurrent safety | Multiple simultaneous commands handled cleanly |

**Full pipeline test pattern:**
```python
def test_full_pipeline_success(mock_llm, simple_scene):
    state = run_pipeline({
        "transcript": "approach the red cube",
        "scene_data": simple_scene,
        "action_plan": [{"action": "APPROACH", "params": {"target": "red_cube"}}],
    })
    assert state["final_state"] == "EXECUTING"
    assert state["is_safe"] is True
    assert len(state["waypoints"]) > 0

def test_hitl_blocks_without_confirmation(mock_llm, large_scene):
    state = run_pipeline({
        "transcript": "sort all objects by color",
        "action_plan": [... 8 actions ...],
        "human_confirmation_granted": False,
    })
    assert state["requires_confirmation"] is True
    assert state["final_state"] != "EXECUTING"
```

---

## Test Utilities

### `conftest.py` (implicit via pytest fixtures in each file)

Common helpers used across test files:

```python
def make_scene(**kwargs) -> SceneState:
    """Build a minimal SceneState for testing."""

def box(pos, size, color="red", id="test_obj") -> SceneObject:
    """Create a box SceneObject."""

def make_waypoints(n: int, spacing=0.1) -> list[Waypoint]:
    """Create n waypoints in a straight line."""
```

---

## Running in CI

The test suite is designed to run in any Python 3.11+ environment with no external services:

```bash
# Install test dependencies
pip install -r requirements.txt

# Run with coverage
python3 -m pytest tests/ --cov=. --cov-report=term-missing

# Run with JUnit XML output (for CI)
python3 -m pytest tests/ --junitxml=test-results.xml
```

**No API keys required** — all LLM/VLM calls in tests use `unittest.mock.AsyncMock`.
