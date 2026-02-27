# backend/ai — AI & Language Model Layer

This package contains all AI model clients, prompt engineering, and response parsers. It sits between the FastAPI WebSocket handler and the core execution engine.

---

## Module Map

```
ai/
├── llm_client.py         ← Unified LLM client: Groq → Gemini → Ollama fallback
├── vlm_client.py         ← Vision-Language Model client (Ollama)
├── task_decomposer.py    ← Natural language → JSON action plan
├── scene_analyzer.py     ← Frontend scene JSON → SceneGraph + spatial relations
├── procedure_extractor.py ← Keyframe images → validated action sequence
└── prompts/
    ├── task_decompose.txt ← System prompt for Command Mode LLM
    └── teach_extract.txt  ← System prompt for Teach Mode VLM
```

---

## llm_client.py — Unified LLM Client

Provides a single `LLMClient` interface that abstracts over three backend providers with automatic fallback.

### Provider Fallback Chain

```
LLMClient.chat(messages)
        │
        ▼
1. GROQ  ─── GROQ_API_KEY set? ──NO──────────────────────────┐
        │         YES                                         │
        ▼                                                     │
    GroqClient.chat()                                         │
        │   success? ──YES──► return LLMResponse              │
        │   RateLimitError / HTTPError / Timeout              │
        ▼                                                     │
    _skip_groq = True                                         │
        │                                                     │
        ▼                                                     ▼
2. GEMINI ── GEMINI_API_KEY set? ──NO──────────────────────────┐
        │         YES                                          │
        ▼                                                      │
    GeminiClient.chat()                                        │
        │   success? ──YES──► return LLMResponse               │
        │   RateLimitError / HTTPError                         │
        ▼                                                      │
    _skip_gemini = True                                        │
        │                                                      │
        ▼                                                      ▼
3. OLLAMA ─────────────────────────────────────────────────────┘
        │
        ▼
    OllamaClient.chat()
        │   success? ──YES──► return LLMResponse
        │   ConnectionError
        ▼
    RuntimeError("No LLM available. Status: ...")
    (diagnostic message lists which providers are missing)
```

### Classes

#### `GroqClient`
- **Model:** `meta-llama/llama-4-scout-17b-16e-instruct` (falls back to `llama-3.1-8b-instant`)
- **API:** OpenAI-compatible REST at `https://api.groq.com/openai/v1`
- **Auth:** `Authorization: Bearer {GROQ_API_KEY}`
- **JSON mode:** sets `response_format: {"type": "json_object"}` when `json_mode=True`
- **Retries:** 2 retries with fallback to smaller model on rate limit

#### `GeminiClient`
- **Model:** `gemini-2.5-flash-lite` (free tier with quota)
- **API:** `https://generativelanguage.googleapis.com/v1/models/{model}:generateContent?key={API_KEY}`
- **JSON mode:** wraps system prompt with JSON instruction + sets `responseMimeType: "application/json"`
- **Message mapping:** converts OpenAI-style `[{role, content}]` to Gemini's `contents` + `systemInstruction` format

#### `OllamaClient`
- **Model:** `llama3.2:3b` (auto-detected from running instance)
- **API:** `POST http://localhost:11434/api/chat`
- **JSON mode:** sets `format: "json"` in Ollama payload
- **Timeout:** 60s (local inference is slower)

#### `LLMClient` (unified)
```python
client = LLMClient()          # reads keys from environment
response = await client.chat(
    messages=[{"role": "user", "content": "..."}],
    temperature=0.1,
    max_tokens=2048,
    json_mode=True,
)
print(response.content)       # string
print(response.provider)      # LLMProvider.GROQ / .GEMINI / .OLLAMA
print(response.model)         # e.g. "meta-llama/llama-4-scout-17b-16e-instruct"
```

#### `LLMResponse`
```python
@dataclass
class LLMResponse:
    content: str          # text/JSON response
    provider: LLMProvider # which provider answered
    model: str            # exact model name used
    usage: dict           # token counts
    raw: dict             # full API response
```

---

## vlm_client.py — Vision-Language Model Client

Connects to a locally running **Ollama** instance with a vision-capable model. Used exclusively by the Teach Mode pipeline.

### Supported Models (auto-detected in priority order)
1. `pixtral:12b` — best quality
2. `llava:13b` — good quality, widely available
3. `llava:7b` — faster, lower quality
4. `llava:latest` — whatever Ollama has

### `VLMClient.analyze_images()`

```python
response = await vlm_client.analyze_images(
    images_base64=["base64string1", "base64string2", ...],  # up to 12 frames
    system_prompt=teach_extract_prompt,
    user_prompt="Analyze these keyframes...",
    temperature=0.1,
    max_tokens=4096,
    json_mode=True,
)
```

- Strips `data:image/...;base64,` URI prefix automatically
- Sends images as Ollama's `"images"` field in the chat message
- Timeout: 120s (vision inference is slow)

---

## task_decomposer.py — Natural Language → Action Plan

Takes a user's voice transcript and the current scene description, builds a system prompt, and calls the LLM to produce a JSON action plan.

### Flow

```
decompose_command(transcript, scene_state, llm_client)
    │
    ▼
Build system prompt:
    - Primitive library overview (all 12 primitives + parameters)
    - Current scene description (from SceneGraph.to_description())
    - Output format specification (JSON array of actions)
    │
    ▼
LLMClient.chat(messages, json_mode=True)
    │
    ▼
Parse JSON response → list of action dicts
    │
    ▼
Validate each action:
    - action ID exists in PRIMITIVE_REGISTRY?
    - required parameters present?
    - parameter types correct?
    │
    ▼
Return DecompositionResult(actions=[...], raw=..., confidence_scores={...})
```

### Retry Logic

If the LLM returns invalid JSON or unknown primitives, `task_decomposer` retries up to 3 times with:
- Increasing temperature (0.1 → 0.3 → 0.6)
- Error feedback appended to the prompt ("Your previous response had these issues: ...")

### Example

```
Input:  "sort the objects by color from left to right"

Output: [
  {"action": "SORT", "params": {"objects": ["red_cube", "blue_cylinder", "green_sphere"], "criterion": "color", "direction": "left_to_right"}}
]
```

---

## scene_analyzer.py — Scene Graph Builder

Converts the raw JSON scene state from the frontend into a rich `SceneGraph` with computed spatial relationships.

### `SceneGraph`

```python
@dataclass
class SceneGraph:
    objects: list[SceneObject]          # all objects in scene
    relations: list[SpatialRelation]    # computed pairwise relations
    table_height: float
    end_effector: tuple[float, float, float]
    gripper_open: bool
    held_object_id: str | None

    def to_description(self) -> str:    # → natural language for LLM prompt
    def to_dict(self) -> dict           # → JSON for API responses
```

### Spatial Relations Computed

| Relation | Condition |
|----------|-----------|
| `on_top_of` | dy > 0.075m AND horizontal distance < 0.1m |
| `near` | 3D distance < 0.3m |
| `left_of` | dx < -0.3m |
| `right_of` | dx > +0.3m |
| `in_front_of` | dz < -0.3m |
| `behind` | dz > +0.3m |

### `scene_state_from_frontend(data)`

Parses the WebSocket scene JSON into a `SceneState` object compatible with the core engine:

```python
# Input (from frontend WebSocket message)
{
    "objects": [{"id": "red_cube", "shape": "box", "color": "red", "position": [0.8, 0.65, 0.3], "size": [0.2, 0.2, 0.2]}],
    "end_effector": [0, 1.5, 0],
    "gripper_open": true,
    "table_height": 0.5
}
```

---

## procedure_extractor.py — VLM Keyframe Extractor

Receives temporal keyframe images from the Teach Mode recording, sends them to the VLM, and validates the extracted action sequence.

### Flow

```
extract_procedure(images_base64, vlm_client, confidence_threshold=0.7)
    │
    ▼
Validate: 2–12 images required (trim to 12 if more)
    │
    ▼
Load system prompt from prompts/teach_extract.txt
    │
    ▼
VLMClient.analyze_images(images, system_prompt, user_prompt)
    │
    ▼
Parse JSON response → {"actions": [...], "summary": "...", "objects_detected": [...]}
    │
    ▼
For each action:
    ├── action ID in PRIMITIVE_REGISTRY? → valid_primitive = True/False
    ├── confidence < 0.7? → needs_confirmation = True
    └── confidence < 0.3 AND invalid primitive? → DROP
    │
    ▼
Return ExtractionResult(success, actions, summary, objects_detected, frame_count)
```

### `ExtractedAction`

```python
@dataclass
class ExtractedAction:
    step: int                    # sequence number
    action: str                  # primitive ID (e.g. "GRASP")
    params: dict                 # primitive parameters
    confidence: float            # 0.0 – 1.0
    observation: str             # what the VLM saw in the frames
    needs_confirmation: bool     # True if confidence < threshold
    valid_primitive: bool        # True if action is in registry
    validation_error: str | None # error message if invalid
```

---

## prompts/

### task_decompose.txt
System prompt for the LLM when decomposing voice commands. Contains:
- Full list of all 12 primitives with parameter descriptions
- JSON output format specification
- Few-shot examples
- Instructions to use only known object IDs from the scene

### teach_extract.txt
System prompt for the VLM when analyzing keyframe images. Contains:
- Instructions to identify objects and their movements between frames
- Output format specification (actions array with confidence scores)
- Available primitive list
- Instructions to describe what was observed at each step
