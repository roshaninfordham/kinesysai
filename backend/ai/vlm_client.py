"""
KINESYS — Vision-Language Model Client

Connects to Ollama's local API for vision models (Pixtral 12B, LLaVA, etc.).
Supports multi-image input — sending 4-8 base64 images in a single request
with a system prompt for procedural extraction.

Usage:
    client = VLMClient()
    response = await client.analyze_images(images_b64, system_prompt)
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any, List, Optional

import httpx

logger = logging.getLogger("kinesys.vlm")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

OLLAMA_DEFAULT_HOST = "http://localhost:11434"
OLLAMA_VLM_MODELS = ["pixtral:12b", "llava:13b", "llava:7b", "llava:latest"]
OLLAMA_VLM_TIMEOUT_S = 120.0  # VLM inference is slower than text-only


@dataclass
class VLMResponse:
    """Structured response from a vision-language model."""

    content: str
    model: str
    usage: dict = field(default_factory=dict)
    raw: dict = field(default_factory=dict)
    error: Optional[str] = None

    @property
    def success(self) -> bool:
        return self.error is None and len(self.content) > 0


# ---------------------------------------------------------------------------
# VLM Client
# ---------------------------------------------------------------------------


class VLMClient:
    """
    Async client for local Ollama vision-language models.

    Supports multi-image requests by embedding base64-encoded images
    directly in the Ollama /api/chat message format.
    """

    def __init__(
        self,
        host: Optional[str] = None,
        model: Optional[str] = None,
    ) -> None:
        self.host = host or os.environ.get("OLLAMA_HOST", OLLAMA_DEFAULT_HOST)
        self._preferred_model = model or os.environ.get("OLLAMA_VLM_MODEL")
        self._resolved_model: Optional[str] = None
        self._http: Optional[httpx.AsyncClient] = None

    async def _get_http(self) -> httpx.AsyncClient:
        if self._http is None or self._http.is_closed:
            self._http = httpx.AsyncClient(
                base_url=self.host,
                timeout=OLLAMA_VLM_TIMEOUT_S,
            )
        return self._http

    async def _resolve_model(self) -> str:
        """Find the first available VLM model on the Ollama instance."""
        if self._resolved_model:
            return self._resolved_model

        # If user specified a model, use it directly
        if self._preferred_model:
            self._resolved_model = self._preferred_model
            return self._resolved_model

        # Probe Ollama for available models
        http = await self._get_http()
        try:
            resp = await http.get("/api/tags")
            resp.raise_for_status()
            data = resp.json()
            available = {m["name"] for m in data.get("models", [])}

            for candidate in OLLAMA_VLM_MODELS:
                if candidate in available:
                    self._resolved_model = candidate
                    logger.info("Resolved VLM model: %s", candidate)
                    return candidate

                # Try without tag (e.g. "llava" matches "llava:latest")
                base_name = candidate.split(":")[0]
                for avail in available:
                    if avail.startswith(base_name):
                        self._resolved_model = avail
                        logger.info("Resolved VLM model: %s (matched %s)", avail, candidate)
                        return avail

            # Fall back to first available vision-capable model
            if available:
                fallback = next(iter(available))
                logger.warning(
                    "No preferred VLM found. Using fallback: %s. "
                    "Available: %s", fallback, available
                )
                self._resolved_model = fallback
                return fallback

            raise RuntimeError(
                "No models available on Ollama. Pull a vision model with: "
                "ollama pull llava:13b"
            )

        except httpx.ConnectError:
            raise ConnectionError(
                f"Cannot connect to Ollama at {self.host}. "
                "Start Ollama with: ollama serve"
            )

    async def analyze_images(
        self,
        images_base64: List[str],
        system_prompt: str,
        user_prompt: str = "Analyze these demonstration keyframes and extract the procedural steps.",
        temperature: float = 0.1,
        max_tokens: int = 4096,
        json_mode: bool = True,
    ) -> VLMResponse:
        """
        Send multiple base64 images to the VLM with a system prompt.

        Args:
            images_base64: List of base64-encoded image strings (no data: prefix).
            system_prompt: System instructions for the VLM.
            user_prompt: User message accompanying the images.
            temperature: Sampling temperature.
            max_tokens: Maximum tokens in response.
            json_mode: If True, request JSON output format.

        Returns:
            VLMResponse with the model's analysis.
        """
        model = await self._resolve_model()
        http = await self._get_http()

        # Strip data URI prefix if present
        cleaned_images = []
        for img in images_base64:
            if img.startswith("data:"):
                # Remove "data:image/jpeg;base64," prefix
                cleaned_images.append(img.split(",", 1)[-1])
            else:
                cleaned_images.append(img)

        # Build Ollama chat message with images
        # Ollama expects images as base64 strings in the "images" field
        messages: List[dict] = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": user_prompt,
                "images": cleaned_images,
            },
        ]

        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": False,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
            },
        }

        if json_mode:
            payload["format"] = "json"

        logger.info(
            "VLM request: model=%s, images=%d, json_mode=%s",
            model, len(cleaned_images), json_mode,
        )

        try:
            resp = await http.post("/api/chat", json=payload)
            resp.raise_for_status()
            data = resp.json()

            content = data.get("message", {}).get("content", "")
            eval_count = data.get("eval_count", 0)
            prompt_count = data.get("prompt_eval_count", 0)

            logger.info(
                "VLM response: model=%s, eval_tokens=%d, prompt_tokens=%d",
                model, eval_count, prompt_count,
            )

            return VLMResponse(
                content=content,
                model=model,
                usage={
                    "prompt_tokens": prompt_count,
                    "completion_tokens": eval_count,
                    "total_tokens": prompt_count + eval_count,
                },
                raw=data,
            )

        except httpx.ConnectError:
            error_msg = (
                f"Cannot connect to Ollama at {self.host}. "
                "Is Ollama running? Start it with: ollama serve"
            )
            logger.error(error_msg)
            return VLMResponse(
                content="",
                model=model,
                error=error_msg,
            )

        except httpx.HTTPStatusError as exc:
            error_msg = f"Ollama HTTP error: {exc.response.status_code} — {exc.response.text[:300]}"
            logger.error(error_msg)
            return VLMResponse(
                content="",
                model=model,
                error=error_msg,
            )

        except httpx.TimeoutException:
            error_msg = f"VLM request timed out after {OLLAMA_VLM_TIMEOUT_S}s"
            logger.error(error_msg)
            return VLMResponse(
                content="",
                model=model,
                error=error_msg,
            )

    async def close(self) -> None:
        if self._http and not self._http.is_closed:
            await self._http.aclose()
