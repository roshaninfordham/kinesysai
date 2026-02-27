"""
KINESYS — Unit Tests for Task Decomposer & Scene Analyzer

Tests the LLM integration pipeline with mocked LLM responses:
  - Scene analysis and graph generation
  - Prompt construction
  - JSON parsing from LLM responses
  - Action validation against scene state
  - Groq → Ollama fallback
  - Retry logic
"""

from __future__ import annotations

import json
import math
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from core.action_primitives import SceneObject, SceneState
from ai.llm_client import LLMClient, LLMResponse, LLMProvider, RateLimitError
from ai.scene_analyzer import (
    SceneGraph,
    SpatialRelation,
    analyze_scene,
    compute_spatial_relations,
    scene_state_from_frontend,
)
from ai.task_decomposer import (
    DecompositionResult,
    decompose_command,
    decompose_command_with_retry,
    _validate_actions,
    _load_decompose_prompt,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def scene() -> SceneState:
    return SceneState(
        objects={
            "red_cube": SceneObject(
                id="red_cube", shape="box", color="red",
                position=(0.5, 0.65, 0.3), size=(0.2, 0.2, 0.2), mass=0.5,
            ),
            "blue_cylinder": SceneObject(
                id="blue_cylinder", shape="cylinder", color="blue",
                position=(-0.5, 0.7, 0.6), size=(0.1, 0.3), mass=0.3,
            ),
            "green_sphere": SceneObject(
                id="green_sphere", shape="sphere", color="green",
                position=(0.3, 0.67, -0.5), size=(0.12,), mass=0.2,
            ),
        },
        end_effector=(0.0, 1.5, 0.0),
        gripper_open=True,
        held_object_id=None,
        table_height=0.5,
    )


def _mock_llm_response(content: str, provider: LLMProvider = LLMProvider.GROQ) -> LLMResponse:
    """Create a mock LLM response with given content."""
    return LLMResponse(
        content=content,
        provider=provider,
        model="test-model",
        usage={"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
    )


# ---------------------------------------------------------------------------
# Scene Analyzer Tests
# ---------------------------------------------------------------------------


class TestSceneAnalyzer:
    def test_analyze_scene_returns_graph(self, scene: SceneState) -> None:
        graph = analyze_scene(scene)
        assert isinstance(graph, SceneGraph)
        assert len(graph.objects) == 3

    def test_scene_description_contains_objects(self, scene: SceneState) -> None:
        graph = analyze_scene(scene)
        desc = graph.to_description()
        assert "red_cube" in desc
        assert "blue_cylinder" in desc
        assert "green_sphere" in desc

    def test_scene_description_contains_positions(self, scene: SceneState) -> None:
        graph = analyze_scene(scene)
        desc = graph.to_description()
        assert "0.50" in desc  # red_cube x position
        assert "0.65" in desc  # red_cube y position

    def test_scene_description_contains_robot_state(self, scene: SceneState) -> None:
        graph = analyze_scene(scene)
        desc = graph.to_description()
        assert "Gripper: open" in desc

    def test_spatial_relations_computed(self, scene: SceneState) -> None:
        objects = list(scene.objects.values())
        relations = compute_spatial_relations(objects)
        assert isinstance(relations, list)
        assert all(isinstance(r, SpatialRelation) for r in relations)

    def test_left_right_relations(self) -> None:
        objects = [
            SceneObject(id="a", shape="box", color="red",
                        position=(-1.0, 0.5, 0.0), size=(0.1,)),
            SceneObject(id="b", shape="box", color="blue",
                        position=(1.0, 0.5, 0.0), size=(0.1,)),
        ]
        relations = compute_spatial_relations(objects)
        rel_strs = [(r.subject, r.relation, r.object) for r in relations]
        assert ("a", "left_of", "b") in rel_strs
        assert ("b", "right_of", "a") in rel_strs

    def test_scene_graph_to_dict(self, scene: SceneState) -> None:
        graph = analyze_scene(scene)
        d = graph.to_dict()
        assert "objects" in d
        assert "relations" in d
        assert "robot" in d
        assert len(d["objects"]) == 3

    def test_scene_state_from_frontend(self) -> None:
        data = {
            "objects": [
                {
                    "id": "cube1",
                    "shape": "box",
                    "color": "#ff0000",
                    "position": [0.5, 0.6, 0.3],
                    "size": [0.2, 0.2, 0.2],
                    "mass": 0.5,
                },
            ],
            "end_effector": [0.0, 1.5, 0.0],
            "gripper_open": True,
            "held_object_id": None,
            "table_height": 0.5,
        }
        state = scene_state_from_frontend(data)
        assert "cube1" in state.objects
        assert state.objects["cube1"].position == (0.5, 0.6, 0.3)
        assert state.gripper_open is True

    def test_spatial_relation_to_natural_language(self) -> None:
        rel = SpatialRelation("a", "on_top_of", "b")
        assert rel.to_natural_language() == "a is on top of b"


# ---------------------------------------------------------------------------
# Action Validation Tests
# ---------------------------------------------------------------------------


class TestActionValidation:
    def test_valid_actions(self, scene: SceneState) -> None:
        actions = [
            {"action": "APPROACH", "params": {"target": "red_cube"}},
            {"action": "GRASP", "params": {"target": "red_cube"}},
        ]
        is_valid, cleaned, error = _validate_actions(actions, scene)
        assert is_valid
        assert len(cleaned) == 2
        assert error is None

    def test_unknown_primitive_fails(self, scene: SceneState) -> None:
        actions = [{"action": "FLY", "params": {}}]
        is_valid, _, error = _validate_actions(actions, scene)
        assert not is_valid
        assert "unknown primitive" in error.lower()

    def test_unknown_target_fails(self, scene: SceneState) -> None:
        actions = [{"action": "APPROACH", "params": {"target": "nonexistent"}}]
        is_valid, _, error = _validate_actions(actions, scene)
        assert not is_valid
        assert "nonexistent" in error

    def test_empty_list_fails(self, scene: SceneState) -> None:
        is_valid, _, error = _validate_actions([], scene)
        assert not is_valid
        assert "empty" in error.lower()

    def test_non_list_fails(self, scene: SceneState) -> None:
        is_valid, _, error = _validate_actions("not a list", scene)
        assert not is_valid

    def test_non_dict_action_fails(self, scene: SceneState) -> None:
        is_valid, _, error = _validate_actions(["not a dict"], scene)
        assert not is_valid

    def test_case_insensitive_action(self, scene: SceneState) -> None:
        actions = [{"action": "approach", "params": {"target": "red_cube"}}]
        is_valid, cleaned, _ = _validate_actions(actions, scene)
        assert is_valid
        assert cleaned[0]["action"] == "APPROACH"

    def test_sort_validates_object_ids(self, scene: SceneState) -> None:
        actions = [{
            "action": "SORT",
            "params": {
                "objects": ["red_cube", "nonexistent"],
                "criterion": "color",
                "direction": "left_to_right",
            },
        }]
        is_valid, _, error = _validate_actions(actions, scene)
        assert not is_valid
        assert "nonexistent" in error

    def test_valid_sort(self, scene: SceneState) -> None:
        actions = [{
            "action": "SORT",
            "params": {
                "objects": ["red_cube", "blue_cylinder", "green_sphere"],
                "criterion": "color",
                "direction": "left_to_right",
            },
        }]
        is_valid, cleaned, _ = _validate_actions(actions, scene)
        assert is_valid


# ---------------------------------------------------------------------------
# LLM Response Parsing Tests
# ---------------------------------------------------------------------------


class TestLLMResponseParsing:
    def test_parse_clean_json(self) -> None:
        content = json.dumps([
            {"action": "APPROACH", "params": {"target": "red_cube"}},
        ])
        resp = _mock_llm_response(content)
        parsed = resp.parse_json()
        assert isinstance(parsed, list)
        assert len(parsed) == 1

    def test_parse_json_with_markdown_fences(self) -> None:
        content = '```json\n[{"action": "WAIT", "params": {"duration_ms": 1000}}]\n```'
        resp = _mock_llm_response(content)
        parsed = resp.parse_json()
        assert isinstance(parsed, list)

    def test_parse_invalid_json_raises(self) -> None:
        resp = _mock_llm_response("This is not JSON at all")
        with pytest.raises(ValueError, match="not valid JSON"):
            resp.parse_json()

    def test_is_valid_json_property(self) -> None:
        good = _mock_llm_response('{"a": 1}')
        assert good.is_valid_json

        bad = _mock_llm_response("not json")
        assert not bad.is_valid_json


# ---------------------------------------------------------------------------
# Prompt Loading Tests
# ---------------------------------------------------------------------------


class TestPromptLoading:
    def test_load_decompose_prompt(self) -> None:
        prompt = _load_decompose_prompt()
        assert "KINESYS" in prompt
        assert "APPROACH" in prompt
        assert "{scene_description}" in prompt
        assert "{user_command}" in prompt

    def test_prompt_contains_examples(self) -> None:
        prompt = _load_decompose_prompt()
        assert "Stack the red cube" in prompt or "stack" in prompt.lower()
        assert "GRASP" in prompt

    def test_prompt_contains_all_primitives(self) -> None:
        prompt = _load_decompose_prompt()
        for prim in ["APPROACH", "GRASP", "RELEASE", "TRANSLATE", "ROTATE",
                      "PLACE", "PUSH", "POUR", "STACK", "SORT", "INSPECT", "WAIT"]:
            assert prim in prompt, f"Primitive {prim} not found in prompt"


# ---------------------------------------------------------------------------
# Decomposer Integration Tests (mocked LLM)
# ---------------------------------------------------------------------------


class TestDecomposer:
    @pytest.mark.asyncio
    async def test_simple_pick_and_place(self, scene: SceneState) -> None:
        mock_response = _mock_llm_response(json.dumps([
            {"action": "APPROACH", "params": {"target": "red_cube"}},
            {"action": "GRASP", "params": {"target": "red_cube"}},
            {"action": "TRANSLATE", "params": {"position": [0.0, 1.0, 0.0]}},
            {"action": "PLACE", "params": {"position": [0.0, 0.55, 0.0]}},
        ]))

        mock_client = AsyncMock(spec=LLMClient)
        mock_client.chat = AsyncMock(return_value=mock_response)
        mock_client.close = AsyncMock()

        result = await decompose_command(
            "Move the red cube to the center", scene, llm_client=mock_client
        )

        assert result.success
        assert len(result.actions) == 4
        assert result.actions[0]["action"] == "APPROACH"
        assert result.actions[1]["action"] == "GRASP"
        assert result.provider == LLMProvider.GROQ

    @pytest.mark.asyncio
    async def test_sort_command(self, scene: SceneState) -> None:
        mock_response = _mock_llm_response(json.dumps([
            {
                "action": "SORT",
                "params": {
                    "objects": ["red_cube", "blue_cylinder", "green_sphere"],
                    "criterion": "color",
                    "direction": "left_to_right",
                },
            },
        ]))

        mock_client = AsyncMock(spec=LLMClient)
        mock_client.chat = AsyncMock(return_value=mock_response)
        mock_client.close = AsyncMock()

        result = await decompose_command(
            "Sort everything by color", scene, llm_client=mock_client
        )

        assert result.success
        assert len(result.actions) == 1
        assert result.actions[0]["action"] == "SORT"

    @pytest.mark.asyncio
    async def test_inspect_command(self, scene: SceneState) -> None:
        mock_response = _mock_llm_response(json.dumps([
            {"action": "INSPECT", "params": {"target": "red_cube"}},
            {"action": "INSPECT", "params": {"target": "blue_cylinder"}},
            {"action": "INSPECT", "params": {"target": "green_sphere"}},
        ]))

        mock_client = AsyncMock(spec=LLMClient)
        mock_client.chat = AsyncMock(return_value=mock_response)
        mock_client.close = AsyncMock()

        result = await decompose_command(
            "What objects do you see?", scene, llm_client=mock_client
        )

        assert result.success
        assert len(result.actions) == 3

    @pytest.mark.asyncio
    async def test_invalid_json_response(self, scene: SceneState) -> None:
        mock_response = _mock_llm_response("I don't understand that command.")

        mock_client = AsyncMock(spec=LLMClient)
        mock_client.chat = AsyncMock(return_value=mock_response)
        mock_client.close = AsyncMock()

        result = await decompose_command(
            "Do something", scene, llm_client=mock_client
        )

        assert not result.success
        assert result.error is not None

    @pytest.mark.asyncio
    async def test_invalid_target_in_response(self, scene: SceneState) -> None:
        mock_response = _mock_llm_response(json.dumps([
            {"action": "APPROACH", "params": {"target": "phantom_object"}},
        ]))

        mock_client = AsyncMock(spec=LLMClient)
        mock_client.chat = AsyncMock(return_value=mock_response)
        mock_client.close = AsyncMock()

        result = await decompose_command(
            "Grab the phantom object", scene, llm_client=mock_client
        )

        assert not result.success
        assert "phantom_object" in result.error

    @pytest.mark.asyncio
    async def test_response_with_markdown_fences(self, scene: SceneState) -> None:
        content = '```json\n[{"action": "WAIT", "params": {"duration_ms": 1000}}]\n```'
        mock_response = _mock_llm_response(content)

        mock_client = AsyncMock(spec=LLMClient)
        mock_client.chat = AsyncMock(return_value=mock_response)
        mock_client.close = AsyncMock()

        result = await decompose_command(
            "Wait a second", scene, llm_client=mock_client
        )

        assert result.success
        assert result.actions[0]["action"] == "WAIT"

    @pytest.mark.asyncio
    async def test_response_wrapped_in_dict(self, scene: SceneState) -> None:
        """Some LLMs wrap the array in {"actions": [...]}"""
        content = json.dumps({
            "actions": [
                {"action": "APPROACH", "params": {"target": "red_cube"}},
                {"action": "GRASP", "params": {"target": "red_cube"}},
            ]
        })
        mock_response = _mock_llm_response(content)

        mock_client = AsyncMock(spec=LLMClient)
        mock_client.chat = AsyncMock(return_value=mock_response)
        mock_client.close = AsyncMock()

        result = await decompose_command(
            "Grab the red cube", scene, llm_client=mock_client
        )

        assert result.success
        assert len(result.actions) == 2

    @pytest.mark.asyncio
    async def test_result_to_dict(self, scene: SceneState) -> None:
        mock_response = _mock_llm_response(json.dumps([
            {"action": "WAIT", "params": {"duration_ms": 500}},
        ]))

        mock_client = AsyncMock(spec=LLMClient)
        mock_client.chat = AsyncMock(return_value=mock_response)
        mock_client.close = AsyncMock()

        result = await decompose_command(
            "Pause", scene, llm_client=mock_client
        )

        d = result.to_dict()
        assert d["success"] is True
        assert d["action_count"] == 1
        assert "provider" in d

    @pytest.mark.asyncio
    async def test_llm_call_failure(self, scene: SceneState) -> None:
        mock_client = AsyncMock(spec=LLMClient)
        mock_client.chat = AsyncMock(side_effect=RuntimeError("No LLM available"))
        mock_client.close = AsyncMock()

        result = await decompose_command(
            "Do something", scene, llm_client=mock_client
        )

        assert not result.success
        assert "LLM call failed" in result.error

    @pytest.mark.asyncio
    async def test_retry_succeeds_on_second_attempt(self, scene: SceneState) -> None:
        bad_response = _mock_llm_response("not valid json")
        good_response = _mock_llm_response(json.dumps([
            {"action": "WAIT", "params": {"duration_ms": 1000}},
        ]))

        mock_client = AsyncMock(spec=LLMClient)
        mock_client.chat = AsyncMock(side_effect=[bad_response, good_response])
        mock_client.close = AsyncMock()

        result = await decompose_command_with_retry(
            "Wait", scene, llm_client=mock_client, max_retries=1
        )

        assert result.success
        assert mock_client.chat.call_count == 2

    @pytest.mark.asyncio
    async def test_retry_all_fail(self, scene: SceneState) -> None:
        bad_response = _mock_llm_response("nope")

        mock_client = AsyncMock(spec=LLMClient)
        mock_client.chat = AsyncMock(return_value=bad_response)
        mock_client.close = AsyncMock()

        result = await decompose_command_with_retry(
            "???", scene, llm_client=mock_client, max_retries=1
        )

        assert not result.success
