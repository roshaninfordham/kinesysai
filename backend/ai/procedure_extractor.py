"""
KINESYS — Procedure Extractor

Receives an array of keyframe images from the WebSocket, constructs a
multi-image prompt using the teach_extract.txt template, sends it to the
VLM, parses the structured response, and validates each extracted action
against the primitive library.

Actions below the confidence threshold (default 0.7) are flagged with
needs_confirmation: true.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from ai.vlm_client import VLMClient
from core.action_primitives import PRIMITIVE_REGISTRY

logger = logging.getLogger("kinesys.procedure_extractor")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CONFIDENCE_THRESHOLD = 0.7
MIN_IMAGES = 2
MAX_IMAGES = 12
PROMPT_PATH = Path(__file__).parent / "prompts" / "teach_extract.txt"


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class ExtractedAction:
    """A single action extracted from demonstration keyframes."""

    step: int
    action: str
    params: Dict[str, Any]
    confidence: float
    observation: str
    needs_confirmation: bool = False
    valid_primitive: bool = True
    validation_error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "step": self.step,
            "action": self.action,
            "params": self.params,
            "confidence": self.confidence,
            "observation": self.observation,
            "needs_confirmation": self.needs_confirmation,
            "valid_primitive": self.valid_primitive,
            "validation_error": self.validation_error,
        }


@dataclass
class ExtractionResult:
    """Result of procedural extraction from demonstration keyframes."""

    success: bool
    actions: List[ExtractedAction] = field(default_factory=list)
    summary: str = ""
    objects_detected: List[str] = field(default_factory=list)
    frame_count: int = 0
    error: Optional[str] = None
    raw_response: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "success": self.success,
            "actions": [a.to_dict() for a in self.actions],
            "summary": self.summary,
            "objects_detected": self.objects_detected,
            "frame_count": self.frame_count,
            "error": self.error,
        }


# ---------------------------------------------------------------------------
# Prompt loader
# ---------------------------------------------------------------------------


def _load_system_prompt() -> str:
    """Load the teach extraction system prompt from disk."""
    try:
        return PROMPT_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        logger.error("Prompt file not found: %s", PROMPT_PATH)
        raise RuntimeError(f"Missing prompt file: {PROMPT_PATH}")


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _validate_action(action_dict: Dict[str, Any]) -> ExtractedAction:
    """
    Validate a single action dict from the VLM response against the
    primitive library. Returns an ExtractedAction with validation metadata.
    """
    step = action_dict.get("step", 0)
    action_id = action_dict.get("action", "").upper()
    params = action_dict.get("params", {})
    confidence = float(action_dict.get("confidence", 0.0))
    observation = action_dict.get("observation", "")

    # Clamp confidence to [0, 1]
    confidence = max(0.0, min(1.0, confidence))

    # Check if primitive exists in registry
    valid_primitive = action_id in PRIMITIVE_REGISTRY
    validation_error = None

    if not valid_primitive:
        validation_error = (
            f"Unknown primitive '{action_id}'. "
            f"Available: {list(PRIMITIVE_REGISTRY.keys())}"
        )
        logger.warning("Invalid primitive at step %d: %s", step, action_id)

    # Flag low-confidence actions
    needs_confirmation = confidence < CONFIDENCE_THRESHOLD

    return ExtractedAction(
        step=step,
        action=action_id,
        params=params,
        confidence=confidence,
        observation=observation,
        needs_confirmation=needs_confirmation,
        valid_primitive=valid_primitive,
        validation_error=validation_error,
    )


def _parse_vlm_response(raw: str) -> Dict[str, Any]:
    """
    Parse the VLM's JSON response. Handles markdown code fences and
    common formatting issues.
    """
    text = raw.strip()

    # Strip markdown code fences if present
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [line for line in lines if not line.strip().startswith("```")]
        text = "\n".join(lines).strip()

    # Try to extract JSON object
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try to find JSON object in the response
    start = text.find("{")
    end = text.rfind("}") + 1
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end])
        except json.JSONDecodeError:
            pass

    raise ValueError(f"Could not parse VLM response as JSON: {text[:500]}")


# ---------------------------------------------------------------------------
# Main extractor
# ---------------------------------------------------------------------------


async def extract_procedure(
    images_base64: List[str],
    vlm_client: Optional[VLMClient] = None,
    confidence_threshold: float = CONFIDENCE_THRESHOLD,
) -> ExtractionResult:
    """
    Extract a structured procedure from demonstration keyframe images.

    Args:
        images_base64: List of base64-encoded keyframe images.
        vlm_client: Optional VLMClient instance. Creates one if not provided.
        confidence_threshold: Minimum confidence to auto-accept an action.

    Returns:
        ExtractionResult with validated action sequence.
    """
    # Validate input
    if not images_base64:
        return ExtractionResult(
            success=False,
            error="No keyframe images provided",
        )

    if len(images_base64) < MIN_IMAGES:
        return ExtractionResult(
            success=False,
            error=f"At least {MIN_IMAGES} keyframe images required, got {len(images_base64)}",
        )

    # Limit number of images to avoid overloading the VLM
    images = images_base64[:MAX_IMAGES]
    if len(images_base64) > MAX_IMAGES:
        logger.warning(
            "Trimmed keyframe count from %d to %d",
            len(images_base64), MAX_IMAGES,
        )

    # Load prompt
    try:
        system_prompt = _load_system_prompt()
    except RuntimeError as exc:
        return ExtractionResult(success=False, error=str(exc))

    # Build user prompt with frame count context
    user_prompt = (
        f"I am showing you {len(images)} keyframe images from a webcam demonstration "
        f"of a robotic manipulation task. The images are in temporal order "
        f"(frame 1 is earliest, frame {len(images)} is latest). "
        f"Analyze the visual changes between consecutive frames and extract "
        f"the procedural steps as specified in your instructions."
    )

    # Create client if needed
    own_client = vlm_client is None
    if own_client:
        vlm_client = VLMClient()

    try:
        response = await vlm_client.analyze_images(
            images_base64=images,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=0.1,
            max_tokens=4096,
            json_mode=True,
        )

        if not response.success:
            return ExtractionResult(
                success=False,
                error=response.error or "VLM returned empty response",
                raw_response=response.content,
            )

        # Parse JSON response
        try:
            parsed = _parse_vlm_response(response.content)
        except ValueError as exc:
            return ExtractionResult(
                success=False,
                error=str(exc),
                raw_response=response.content,
            )

        # Extract and validate actions
        raw_actions = parsed.get("actions", [])
        if not isinstance(raw_actions, list):
            return ExtractionResult(
                success=False,
                error="VLM response 'actions' field is not a list",
                raw_response=response.content,
            )

        validated_actions: List[ExtractedAction] = []
        for i, action_dict in enumerate(raw_actions):
            if not isinstance(action_dict, dict):
                logger.warning("Skipping non-dict action at index %d", i)
                continue

            action = _validate_action(action_dict)

            # Override threshold if custom value provided
            if confidence_threshold != CONFIDENCE_THRESHOLD:
                action.needs_confirmation = action.confidence < confidence_threshold

            validated_actions.append(action)

        # Filter out completely invalid actions (unknown primitives with
        # very low confidence), but keep low-confidence valid primitives
        # so the user can confirm them
        kept_actions: List[ExtractedAction] = []
        for action in validated_actions:
            if not action.valid_primitive and action.confidence < 0.3:
                logger.info(
                    "Dropping invalid low-confidence action: %s (%.2f)",
                    action.action, action.confidence,
                )
                continue
            kept_actions.append(action)

        summary = parsed.get("summary", "")
        objects_detected = parsed.get("objects_detected", [])
        frame_count = parsed.get("frame_count", len(images))

        logger.info(
            "Extraction complete: %d actions (%d need confirmation), summary: %s",
            len(kept_actions),
            sum(1 for a in kept_actions if a.needs_confirmation),
            summary,
        )

        return ExtractionResult(
            success=True,
            actions=kept_actions,
            summary=summary,
            objects_detected=objects_detected,
            frame_count=frame_count,
            raw_response=response.content,
        )

    except Exception as exc:
        logger.exception("Procedure extraction failed")
        return ExtractionResult(
            success=False,
            error=f"Extraction failed: {exc}",
        )

    finally:
        if own_client and vlm_client:
            await vlm_client.close()
