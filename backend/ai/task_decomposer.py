"""
KINESYS — Task Decomposer

Takes a natural language command and scene state, sends them to the LLM
with the decomposition system prompt, and parses the response into a
validated list of Action dicts matching the primitive schema.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ai.llm_client import LLMClient, LLMResponse, LLMProvider
from ai.scene_analyzer import SceneGraph, analyze_scene
from core.action_primitives import SceneState, PRIMITIVE_REGISTRY

logger = logging.getLogger("kinesys.decomposer")

# ---------------------------------------------------------------------------
# Prompt loading
# ---------------------------------------------------------------------------

PROMPT_DIR = Path(__file__).resolve().parent / "prompts"
DECOMPOSE_PROMPT_PATH = PROMPT_DIR / "decompose.txt"

_cached_prompt: str | None = None


def _load_decompose_prompt() -> str:
    """Load and cache the decomposition system prompt."""
    global _cached_prompt
    if _cached_prompt is None:
        with open(DECOMPOSE_PROMPT_PATH, "r") as f:
            _cached_prompt = f.read()
    return _cached_prompt


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

VALID_ACTIONS = set(PRIMITIVE_REGISTRY.keys())


@dataclass
class DecompositionResult:
    """Result of decomposing a natural language command into actions."""

    success: bool
    actions: list[dict[str, Any]]
    raw_response: str
    provider: LLMProvider
    model: str
    error: str | None = None
    token_usage: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "actions": self.actions,
            "action_count": len(self.actions),
            "provider": self.provider.value,
            "model": self.model,
            "error": self.error,
            "token_usage": self.token_usage,
        }


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _validate_actions(
    actions: list[dict[str, Any]],
    scene: SceneState,
) -> tuple[bool, list[dict[str, Any]], str | None]:
    """
    Validate parsed actions against the primitive schema and scene.

    Returns (is_valid, cleaned_actions, error_message).
    """
    if not isinstance(actions, list):
        return False, [], "LLM output is not a JSON array"

    if len(actions) == 0:
        return False, [], "LLM returned empty action list"

    cleaned: list[dict[str, Any]] = []
    object_ids = set(scene.objects.keys())

    for i, action in enumerate(actions):
        if not isinstance(action, dict):
            return False, [], f"Action {i} is not a dict: {action}"

        action_type = action.get("action", "").upper()

        if action_type not in VALID_ACTIONS:
            return False, [], (
                f"Action {i}: unknown primitive '{action_type}'. "
                f"Allowed: {sorted(VALID_ACTIONS)}"
            )

        params = action.get("params", {})
        if not isinstance(params, dict):
            return False, [], f"Action {i}: 'params' must be a dict"

        # Validate target references
        target = params.get("target")
        if target and target not in object_ids:
            return False, [], (
                f"Action {i} ({action_type}): target '{target}' not in scene. "
                f"Available: {sorted(object_ids)}"
            )

        target_container = params.get("target_container")
        if target_container and target_container not in object_ids:
            return False, [], (
                f"Action {i} ({action_type}): target_container '{target_container}' "
                f"not in scene. Available: {sorted(object_ids)}"
            )

        # Validate object lists (SORT)
        objects_list = params.get("objects")
        if objects_list:
            for obj_id in objects_list:
                if obj_id not in object_ids:
                    return False, [], (
                        f"Action {i} ({action_type}): object '{obj_id}' "
                        f"not in scene. Available: {sorted(object_ids)}"
                    )

        cleaned.append({"action": action_type, "params": params})

    return True, cleaned, None


# ---------------------------------------------------------------------------
# Main decomposer
# ---------------------------------------------------------------------------


async def decompose_command(
    command: str,
    scene: SceneState,
    llm_client: LLMClient | None = None,
    temperature: float = 0.1,
    max_tokens: int = 2048,
) -> DecompositionResult:
    """
    Decompose a natural language command into a sequence of robot actions.

    Args:
        command: Natural language instruction (e.g., "stack the red cube on blue")
        scene: Current scene state with object positions
        llm_client: LLM client instance (creates one if None)
        temperature: LLM sampling temperature
        max_tokens: Max response tokens

    Returns:
        DecompositionResult with validated action sequence
    """
    # Build the prompt
    scene_graph: SceneGraph = analyze_scene(scene)
    scene_description = scene_graph.to_description()

    prompt_template = _load_decompose_prompt()
    system_prompt = prompt_template.replace(
        "{scene_description}", scene_description
    ).replace(
        "{user_command}", command
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": command},
    ]

    # Call LLM
    own_client = llm_client is None
    if own_client:
        llm_client = LLMClient()

    try:
        response: LLMResponse = await llm_client.chat(
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            json_mode=False,  # We want raw text so we can strip fences
        )
    except Exception as exc:
        logger.error("LLM call failed: %s", exc)
        return DecompositionResult(
            success=False,
            actions=[],
            raw_response="",
            provider=LLMProvider.GROQ,
            model="unknown",
            error=f"LLM call failed: {exc}",
        )
    finally:
        if own_client and llm_client:
            await llm_client.close()

    # Parse JSON from response
    try:
        parsed = response.parse_json()
    except ValueError as exc:
        logger.error("Failed to parse LLM response as JSON: %s", exc)
        return DecompositionResult(
            success=False,
            actions=[],
            raw_response=response.content,
            provider=response.provider,
            model=response.model,
            error=str(exc),
            token_usage=response.usage,
        )

    # Handle case where LLM wraps in {"actions": [...]}
    if isinstance(parsed, dict) and "actions" in parsed:
        parsed = parsed["actions"]

    # Validate actions
    is_valid, actions, error = _validate_actions(parsed, scene)

    if not is_valid:
        logger.warning("Action validation failed: %s", error)
        return DecompositionResult(
            success=False,
            actions=[],
            raw_response=response.content,
            provider=response.provider,
            model=response.model,
            error=error,
            token_usage=response.usage,
        )

    logger.info(
        "Decomposed '%s' into %d actions via %s/%s",
        command[:50],
        len(actions),
        response.provider.value,
        response.model,
    )

    return DecompositionResult(
        success=True,
        actions=actions,
        raw_response=response.content,
        provider=response.provider,
        model=response.model,
        token_usage=response.usage,
    )


async def decompose_command_with_retry(
    command: str,
    scene: SceneState,
    llm_client: LLMClient | None = None,
    max_retries: int = 2,
) -> DecompositionResult:
    """
    Decompose with retry on parse/validation failures.
    Increases temperature slightly on each retry.
    """
    last_result: DecompositionResult | None = None

    for attempt in range(max_retries + 1):
        temp = 0.1 + attempt * 0.15  # 0.1, 0.25, 0.4
        result = await decompose_command(
            command, scene, llm_client, temperature=temp
        )
        if result.success:
            return result
        last_result = result
        logger.warning(
            "Decomposition attempt %d failed: %s", attempt + 1, result.error
        )

    return last_result or DecompositionResult(
        success=False,
        actions=[],
        raw_response="",
        provider=LLMProvider.GROQ,
        model="unknown",
        error="All decomposition attempts failed",
    )
