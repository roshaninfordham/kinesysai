"""
KINESYS — Unified LLM Client

Supports Groq API (primary) and Ollama (fallback). Auto-switches to
Ollama if Groq returns a rate limit error (HTTP 429).

Usage:
    client = LLMClient()
    response = await client.chat("What is 2+2?")
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import httpx

logger = logging.getLogger("kinesys.llm")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

GROQ_DEFAULT_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"
GROQ_FALLBACK_MODEL = "llama-3.1-8b-instant"
OLLAMA_DEFAULT_MODEL = "llama3.2:3b"
OLLAMA_DEFAULT_HOST = "http://localhost:11434"
GEMINI_DEFAULT_MODEL = "gemini-2.5-flash-lite"
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1"

GROQ_API_BASE = "https://api.groq.com/openai/v1"
GROQ_MAX_RETRIES = 2
GROQ_TIMEOUT_S = 30.0
OLLAMA_TIMEOUT_S = 60.0
GEMINI_TIMEOUT_S = 30.0


class LLMProvider(Enum):
    GROQ = "groq"
    GEMINI = "gemini"
    OLLAMA = "ollama"


@dataclass
class LLMResponse:
    """Structured response from the LLM."""

    content: str
    provider: LLMProvider
    model: str
    usage: dict[str, int] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def is_valid_json(self) -> bool:
        try:
            json.loads(self.content)
            return True
        except (json.JSONDecodeError, TypeError):
            return False

    def parse_json(self) -> Any:
        """Parse the content as JSON. Raises ValueError on failure."""
        # Strip markdown code fences if present
        text = self.content.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            # Remove first line (```json) and last line (```)
            lines = [l for l in lines if not l.strip().startswith("```")]
            text = "\n".join(lines).strip()

        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"LLM response is not valid JSON: {exc}\nContent: {text[:500]}"
            ) from exc


# ---------------------------------------------------------------------------
# Groq Client
# ---------------------------------------------------------------------------


class GroqClient:
    """Async client for Groq API using httpx (no SDK dependency on async)."""

    def __init__(self, api_key: str | None = None, model: str | None = None) -> None:
        self.api_key = api_key or os.environ.get("GROQ_API_KEY", "")
        self.model = model or GROQ_DEFAULT_MODEL
        self._http: httpx.AsyncClient | None = None

    async def _get_http(self) -> httpx.AsyncClient:
        if self._http is None or self._http.is_closed:
            self._http = httpx.AsyncClient(
                base_url=GROQ_API_BASE,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                timeout=GROQ_TIMEOUT_S,
            )
        return self._http

    async def chat(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.1,
        max_tokens: int = 2048,
        json_mode: bool = False,
    ) -> LLMResponse:
        """Send a chat completion request to Groq."""
        if not self.api_key:
            raise ValueError("GROQ_API_KEY not set. Set it in .env or environment.")

        http = await self._get_http()

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        for attempt in range(GROQ_MAX_RETRIES + 1):
            try:
                resp = await http.post("/chat/completions", json=payload)

                if resp.status_code == 429:
                    logger.warning("Groq rate limited (429). Attempt %d/%d",
                                   attempt + 1, GROQ_MAX_RETRIES + 1)
                    if attempt < GROQ_MAX_RETRIES:
                        import asyncio
                        await asyncio.sleep(2 ** attempt)
                        continue
                    raise RateLimitError("Groq rate limit exceeded after retries")

                if resp.status_code == 400:
                    # Model might not exist, try fallback model
                    error_body = resp.json()
                    error_msg = error_body.get("error", {}).get("message", "")
                    if "model" in error_msg.lower() or "not found" in error_msg.lower():
                        logger.warning("Model %s not available, trying %s",
                                       self.model, GROQ_FALLBACK_MODEL)
                        payload["model"] = GROQ_FALLBACK_MODEL
                        self.model = GROQ_FALLBACK_MODEL
                        continue
                    resp.raise_for_status()

                resp.raise_for_status()
                data = resp.json()

                content = data["choices"][0]["message"]["content"]
                usage = data.get("usage", {})

                logger.info(
                    "Groq response: model=%s tokens=%s",
                    data.get("model", self.model),
                    usage.get("total_tokens", "?"),
                )

                return LLMResponse(
                    content=content,
                    provider=LLMProvider.GROQ,
                    model=data.get("model", self.model),
                    usage={
                        "prompt_tokens": usage.get("prompt_tokens", 0),
                        "completion_tokens": usage.get("completion_tokens", 0),
                        "total_tokens": usage.get("total_tokens", 0),
                    },
                    raw=data,
                )

            except httpx.TimeoutException:
                logger.warning("Groq timeout. Attempt %d/%d", attempt + 1, GROQ_MAX_RETRIES + 1)
                if attempt >= GROQ_MAX_RETRIES:
                    raise
            except httpx.HTTPStatusError:
                raise

        raise RuntimeError("Groq request failed after all retries")

    async def close(self) -> None:
        if self._http and not self._http.is_closed:
            await self._http.aclose()


class RateLimitError(Exception):
    """Raised when Groq rate limit is exceeded."""


# ---------------------------------------------------------------------------
# Gemini Client
# ---------------------------------------------------------------------------


class GeminiClient:
    """Async client for Google Gemini API (REST generateContent endpoint)."""

    def __init__(self, api_key: str | None = None, model: str | None = None) -> None:
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY", "")
        self.model = model or GEMINI_DEFAULT_MODEL
        self._http: httpx.AsyncClient | None = None

    async def _get_http(self) -> httpx.AsyncClient:
        if self._http is None or self._http.is_closed:
            self._http = httpx.AsyncClient(
                base_url=GEMINI_API_BASE,
                timeout=GEMINI_TIMEOUT_S,
            )
        return self._http

    async def chat(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.1,
        max_tokens: int = 2048,
        json_mode: bool = False,
    ) -> LLMResponse:
        """Send a chat request to Gemini generateContent API."""
        if not self.api_key:
            raise ValueError("GEMINI_API_KEY not set.")

        http = await self._get_http()

        # Convert OpenAI-style messages to Gemini contents format
        # System prompt becomes the first user turn with a special prefix
        contents = []
        system_text = ""
        for msg in messages:
            role = msg.get("role", "user")
            text = msg.get("content", "")
            if role == "system":
                system_text = text
            elif role == "user":
                # Prepend system text to first user message
                if system_text:
                    text = system_text + "\n\n" + text
                    system_text = ""
                contents.append({"role": "user", "parts": [{"text": text}]})
            elif role == "assistant":
                contents.append({"role": "model", "parts": [{"text": text}]})

        payload: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_tokens,
            },
        }
        if json_mode:
            payload["generationConfig"]["responseMimeType"] = "application/json"

        url = f"/models/{self.model}:generateContent?key={self.api_key}"

        try:
            resp = await http.post(url, json=payload)

            if resp.status_code == 429:
                raise RateLimitError("Gemini rate limit exceeded")

            resp.raise_for_status()
            data = resp.json()

            # Extract text from response
            candidates = data.get("candidates", [])
            if not candidates:
                raise ValueError("Gemini returned no candidates")

            content = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "")
            usage = data.get("usageMetadata", {})

            logger.info(
                "Gemini response: model=%s tokens=%s",
                self.model,
                usage.get("totalTokenCount", "?"),
            )

            return LLMResponse(
                content=content,
                provider=LLMProvider.GEMINI,
                model=self.model,
                usage={
                    "prompt_tokens": usage.get("promptTokenCount", 0),
                    "completion_tokens": usage.get("candidatesTokenCount", 0),
                    "total_tokens": usage.get("totalTokenCount", 0),
                },
                raw=data,
            )

        except httpx.TimeoutException:
            raise
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(f"Gemini HTTP error: {exc.response.status_code}") from exc

    async def close(self) -> None:
        if self._http and not self._http.is_closed:
            await self._http.aclose()


# ---------------------------------------------------------------------------
# Ollama Client
# ---------------------------------------------------------------------------


class OllamaClient:
    """Async client for local Ollama instance."""

    def __init__(self, host: str | None = None, model: str | None = None) -> None:
        self.host = host or os.environ.get("OLLAMA_HOST", OLLAMA_DEFAULT_HOST)
        self.model = model or OLLAMA_DEFAULT_MODEL
        self._http: httpx.AsyncClient | None = None

    async def _get_http(self) -> httpx.AsyncClient:
        if self._http is None or self._http.is_closed:
            self._http = httpx.AsyncClient(
                base_url=self.host,
                timeout=OLLAMA_TIMEOUT_S,
            )
        return self._http

    async def chat(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.1,
        max_tokens: int = 2048,
        json_mode: bool = False,
    ) -> LLMResponse:
        """Send a chat request to local Ollama."""
        http = await self._get_http()

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
            },
        }
        if json_mode:
            payload["format"] = "json"

        try:
            resp = await http.post("/api/chat", json=payload)
            resp.raise_for_status()
            data = resp.json()

            content = data.get("message", {}).get("content", "")
            eval_count = data.get("eval_count", 0)
            prompt_count = data.get("prompt_eval_count", 0)

            logger.info("Ollama response: model=%s tokens=%d", self.model, eval_count)

            return LLMResponse(
                content=content,
                provider=LLMProvider.OLLAMA,
                model=self.model,
                usage={
                    "prompt_tokens": prompt_count,
                    "completion_tokens": eval_count,
                    "total_tokens": prompt_count + eval_count,
                },
                raw=data,
            )

        except httpx.ConnectError:
            raise ConnectionError(
                f"Cannot connect to Ollama at {self.host}. "
                "Is Ollama running? Start it with: ollama serve"
            )

    async def close(self) -> None:
        if self._http and not self._http.is_closed:
            await self._http.aclose()


# ---------------------------------------------------------------------------
# Unified Client with auto-fallback
# ---------------------------------------------------------------------------


class LLMClient:
    """
    Unified LLM client: Groq → Gemini → Ollama fallback chain.

    Priority:
      1. Groq (fastest, cloud, requires GROQ_API_KEY)
      2. Gemini (reliable fallback, requires GEMINI_API_KEY)
      3. Ollama (local, no API key required, must be running)
    """

    def __init__(
        self,
        groq_api_key: str | None = None,
        groq_model: str | None = None,
        gemini_api_key: str | None = None,
        gemini_model: str | None = None,
        ollama_host: str | None = None,
        ollama_model: str | None = None,
    ) -> None:
        self.groq = GroqClient(api_key=groq_api_key, model=groq_model)
        self.gemini = GeminiClient(api_key=gemini_api_key, model=gemini_model)
        self.ollama = OllamaClient(host=ollama_host, model=ollama_model)
        self._skip_groq = False
        self._skip_gemini = False

    @property
    def active_provider(self) -> LLMProvider:
        if not self._skip_groq and self.groq.api_key:
            return LLMProvider.GROQ
        if not self._skip_gemini and self.gemini.api_key:
            return LLMProvider.GEMINI
        return LLMProvider.OLLAMA

    async def chat(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.1,
        max_tokens: int = 2048,
        json_mode: bool = False,
    ) -> LLMResponse:
        """
        Send a chat request. Tries Groq → Gemini → Ollama in order.
        Skips providers with missing API keys or persistent errors.
        """
        # 1. Try Groq
        if not self._skip_groq and self.groq.api_key:
            try:
                result = await self.groq.chat(messages, temperature, max_tokens, json_mode)
                logger.info("LLM served by Groq/%s", result.model)
                return result
            except RateLimitError:
                logger.warning("Groq rate limited — falling back to Gemini")
                self._skip_groq = True
            except (httpx.HTTPStatusError, httpx.TimeoutException, ValueError, RuntimeError) as exc:
                logger.warning("Groq unavailable (%s) — falling back to Gemini", exc)
                self._skip_groq = True
        else:
            if not self.groq.api_key:
                logger.debug("Groq skipped: GROQ_API_KEY not set")

        # 2. Try Gemini
        if not self._skip_gemini and self.gemini.api_key:
            try:
                result = await self.gemini.chat(messages, temperature, max_tokens, json_mode)
                logger.info("LLM served by Gemini/%s", result.model)
                return result
            except RateLimitError:
                logger.warning("Gemini rate limited — falling back to Ollama")
                self._skip_gemini = True
            except (httpx.HTTPStatusError, httpx.TimeoutException, ValueError, RuntimeError) as exc:
                logger.warning("Gemini unavailable (%s) — falling back to Ollama", exc)
                self._skip_gemini = True
        else:
            if not self.gemini.api_key:
                logger.debug("Gemini skipped: GEMINI_API_KEY not set")

        # 3. Try Ollama
        try:
            result = await self.ollama.chat(messages, temperature, max_tokens, json_mode)
            logger.info("LLM served by Ollama/%s", result.model)
            return result
        except ConnectionError:
            pass

        # All providers failed
        available = []
        if self.groq.api_key:
            available.append("GROQ_API_KEY ✓ (check key validity)")
        else:
            available.append("GROQ_API_KEY ✗ (not set in .env)")
        if self.gemini.api_key:
            available.append("GEMINI_API_KEY ✓ (check key validity)")
        else:
            available.append("GEMINI_API_KEY ✗ (not set in .env)")
        available.append("Ollama ✗ (not running — start with: ollama serve)")

        raise RuntimeError(
            "No LLM available. Status:\n" + "\n".join(f"  • {a}" for a in available)
        )

    async def close(self) -> None:
        await self.groq.close()
        await self.gemini.close()
        await self.ollama.close()
