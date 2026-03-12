# Project: Gemini TryOnMe Everything

## Architecture Overview

Chrome extension (Manifest V3) + Node.js backend on Cloud Run + Python smart search service.

### Outfit Builder Flow

The outfit builder supports **6 categories**: top, bottom, shoes, necklace, earrings, bracelet.

1. **popup.js** reads all 6 fields and passes them as URL params to `wardrobe.html`
2. **wardrobe.js** fires up to 6 parallel `SMART_SEARCH` requests (one per category)
3. Items are rendered: tops/bottoms as hangers, shoes on a rack, accessories in a ceiling bar
4. User selects one item per category, clicks "Try On"
5. **wardrobe.js** sends a single `TRY_ON_OUTFIT` message with all selected garment images
6. **background.js** forwards to `POST /api/try-on/outfit` with the garments array
7. **tryOn.js `/outfit`** preprocesses all garments in parallel, then calls `geminiOutfitTryOn()` with 7 images: user profile photo + 6 garment images

## CRITICAL: Do NOT Change These Settings

### Models
- **Try-on generation**: `gemini-3-pro-image-preview` (in `backend/services/gemini.js`)
- **Background removal / inpainting / accessories**: `gemini-2.5-flash-image` (in `backend/services/imageProcessor.js`)
- Do NOT change these model names. They were validated to work. Previous bugs were caused by using non-existent model names.

### Smart Search Concurrency
- `backend/routes/smartSearch.js` has a concurrency limiter: **MAX_CONCURRENT = 2**
- This prevents OOM crashes on Cloud Run when 6 outfit builder searches hit simultaneously
- Each Playwright browser uses ~400MB; 6 concurrent = 2.4GB > old 2GB limit
- Do NOT remove this limiter or increase MAX_CONCURRENT above 2

### Cloud Run Deploy Settings
- Memory: **4Gi** (required for concurrent Playwright browsers)
- CPU: 2
- Timeout: 600s
- Deploy command:
  ```
  cd backend && gcloud run deploy geminitryonme-backend --source . --region us-central1 --project project-4213188d-5b34-47c7-84e --allow-unauthenticated --timeout=600 --memory=4Gi --cpu=2 --min-instances=0 --max-instances=4
  ```
- Do NOT reduce memory below 4Gi — it will cause OOM crashes

### Outfit Builder UI
- The wardrobe UI files (`extension/outfit-builder/wardrobe.html`, `.css`, `.js`) were copied from the reference implementation at `/reference/extension/outfit-builder/`
- Accessories (necklace, earrings, bracelets) are displayed in a ceiling bar, NOT on the shoe rack
- Accessories skip background removal entirely — they render with original images
- Do NOT restructure the accessory bar layout

### 6 Categories — All Required
- URL params: `top`, `bottom`, `shoes`, `necklace`, `earrings`, `bracelets` (plural)
- `popup.js` must read all 6 input fields and pass them as URL params
- `wardrobe.js` must handle all 6 categories in `initWardrobe()`, `searchCategory()`, `selectItem()`, and `handleTryOn()`
- Try-on requires top AND bottom selected (shoes required only if shoes query was specified)
- Do NOT reduce the number of categories below 6

### Voice Agent (Giselle Live) — CRITICAL Configuration

**Architecture: Vertex AI Backend Proxy**
- Browser connects via WebSocket to our backend at `/ws/voice-live`
- Backend (`backend/routes/voiceLive.js`) proxies to Gemini Live API via Vertex AI using `@google/genai` SDK with `vertexai: true`
- Authentication: Cloud Run service account `erica-deployment-bot` with `roles/aiplatform.user` IAM role
- Reference implementation: https://github.com/ZackAkil/immersive-language-learning-with-live-api
- Do NOT switch to direct browser-to-Gemini connection — Vertex AI requires server-side authentication

**Vertex AI SDK Connection** (in `backend/routes/voiceLive.js`):
- SDK: `@google/genai` Node.js SDK with `vertexai: true`
- Model: `gemini-live-2.5-flash-native-audio` — this is a **native audio** model (generates speech directly, NOT text-to-speech)
- Project: `project-4213188d-5b34-47c7-84e`, Location: `us-central1`
- Connection: `ai.live.connect({ model, config, callbacks })`
- Do NOT change the model name. Previous bugs were caused by wrong model names:
  - `gemini-2.5-flash-preview-native-audio-dialog` → permission errors
  - `gemini-2.0-flash`, `gemini-2.0-flash-live-001` → do NOT support native audio
  - `gemini-2.5-flash-native-audio-latest` → not valid for Vertex AI

**Required config fields in `ai.live.connect()`** (do NOT remove any):
- `responseModalities: [Modality.AUDIO]`
- `inputAudioTranscription: {}`
- `outputAudioTranscription: {}`
- `speechConfig` with `voiceName: "Aoede"`
- `tools: GISELLE_TOOLS` (from `backend/services/giselleLive.js`)

**VAD config** (matches Google's official example — do NOT change):
```
realtimeInputConfig: {
  automaticActivityDetection: {
    disabled: false,
    startOfSpeechSensitivity: START_SENSITIVITY_LOW,
    endOfSpeechSensitivity: END_SENSITIVITY_LOW,
    prefixPaddingMs: 20,
    silenceDurationMs: 100,
  },
},
```
- Reference: https://github.com/GoogleCloudPlatform/generative-ai/blob/main/gemini/multimodal-live-api/intro_multimodal_live_api_genai_sdk.ipynb
- Do NOT change these VAD values — they match Google's official example
- Do NOT add `activityHandling: NO_INTERRUPTION` — server-side barge-in must work natively

**WebSocket server** (in `backend/server.js`):
- Uses `noServer: true` mode with manual `upgrade` event handler
- More reliable on Cloud Run than path-based WebSocket matching
- Do NOT switch back to `new WebSocketServer({ server, path: "/ws/voice-live" })` — it caused 404 on Cloud Run

**Do NOT add these — they cause disconnections**:
- `sessionResumption` — causes 1008 "Operation is not implemented"
- `contextWindowCompression` — causes 1008 "Operation is not implemented"
- `thinkingConfig` — causes immediate session disconnect
- `activityHandling: NO_INTERRUPTION` — breaks natural barge-in behavior
- Any config field not listed above as required

**Message flow**:
- Client sends JSON: `{ setup: { userContext } }` → backend creates Gemini session
- Client sends audio: `{ realtimeInput: { mediaChunks: [...] } }` → backend calls `session.sendRealtimeInput()`
- Client sends tool response: `{ toolResponse: { functionResponses: [...] } }` → backend calls `session.sendToolResponse()`
- Backend forwards Gemini responses to client: audio, transcriptions, tool calls, turn complete

**Configuration files**:
- `backend/routes/voiceLive.js` — WebSocket proxy handler (Vertex AI connection)
- `backend/services/giselleLive.js` — System prompt, tool declarations (`GISELLE_TOOLS`), `buildSystemInstruction()`, `getClientConfig()`
- `extension/popup/popup.js` — Client-side WebSocket connection and tool execution

**IAM Requirements**:
- Service account `erica-deployment-bot` must have `roles/aiplatform.user` on the GCP project
- Without this role: `Permission 'aiplatform.endpoints.predict' denied` → 1008 disconnect

**Variable scoping in popup.js**:
- `autoTryOnFromVoice` MUST be declared at module level (top of file), not inside the voice agent scope
- It is read by the `outfitBuildBtn` click handler AND set by the voice `build_outfit` tool handler — both must share the same scope

### Voice Agent Audio/Echo — CRITICAL, DO NOT CHANGE

The Gemini Live API has **NO built-in echo cancellation**. The following client-side logic in `popup.js` prevents echo-triggered self-interruption while preserving barge-in. These were extremely hard to get right — DO NOT modify them.

**Energy-threshold gating** (in `workletNode.port.onmessage`):
- When model is **silent** (`isModelSpeaking === false`): send ALL mic audio freely, automatic VAD handles it
- When model is **speaking** (`isModelSpeaking === true`):
  - First `ECHO_GRACE_MS` (3000ms): mic is fully muted to let browser AEC calibrate
  - After grace period: only send audio if RMS > `BARGE_IN_RMS` (4500) for `BARGE_IN_CHUNKS` (4) consecutive chunks — allows real barge-in, blocks low-energy echo
- Do NOT remove the energy-threshold gating or replace it with a full mic mute (breaks barge-in)
- Do NOT remove the grace period (breaks greeting)
- Do NOT increase `BARGE_IN_RMS` above ~6000 (makes barge-in too hard to trigger)
- Do NOT decrease `ECHO_GRACE_MS` below 2000 (greeting will get cut off)

**Global tool call guard** (`userSpokeSinceLastModelTurn`):
- ALL tool calls are blocked if the user hasn't spoken since the last model turn
- Prevents hallucinated tool calls from echo/noise being interpreted as speech
- Do NOT remove this guard — it's the last line of defense against model hallucination

**`isModelSpeaking` flag**:
- Set to `true` when binary audio arrives from Gemini (with `modelSpeakingStartTime = Date.now()`)
- Set to `false` on `turnComplete` or `interrupted`
- MUST be reset to `false` on `setupComplete` (new session) — otherwise greeting is blocked

**`muteNextModelTurn` flag** (prevents duplicate announcements):
- Set to `true` after sending tool response for async operations (search, try-on, animate, etc.)
- Suppresses the model's audio AND transcription for the next turn (the duplicate)
- Cleared on `turnComplete`
- MUST be reset to `false` on `setupComplete` (new session) — otherwise greeting is blocked
- The output transcription check must use `&& !muteNextModelTurn` (NOT `return`) to avoid skipping subsequent event processing in `handleGeminiMessage`

**Completion notifications** (`TRYON_COMPLETE`, `VIDEO_COMPLETE`):
- Sent from content.js, results.js, wardrobe.js when operations finish
- Forwarded to Gemini via `sendGeminiText()` as `clientContent` so the model knows the result is visible
- Do NOT remove these — without them the model doesn't know when operations finish

### Voice Agent Behavioral Rules — CRITICAL, DO NOT CHANGE

The voice agent (Giselle) system prompt in `backend/services/giselleLive.js` implements these rules. Do NOT change them.

**Smart Search (single item) — dresses ARE allowed:**
- DIRECT ORDER ("search for a red dress"): acknowledge and call `search_product` immediately
- RECOMMENDATION ("what dress for a wedding?"): describe the item with detail (color, material, style, WHY) → ask "Shall I search for that?" → WAIT for confirmation → then search
- AFTER results load — DIRECT ORDER ("try on number 2"): call `try_on` immediately
- AFTER results load — RECOMMENDATION ("which suits me best?"): call `recommend_items` → explain picks → wait for user to choose

**Outfit Builder (6 categories) — NO dresses, always separate top + bottom:**
- DIRECT ORDER: repeat back all items → confirm → call `build_outfit`
- RECOMMENDATION: describe ALL 6 items with 5+ descriptive words each + WHY → "How does that sound?" → WAIT → confirm → call `build_outfit`
- AFTER wardrobe loads — DIRECT ORDER: call `select_outfit_items` immediately
- AFTER wardrobe loads — RECOMMENDATION: call `recommend_items` → explain each pick category by category with detailed WHY → confirm → call `try_on_outfit`

**When items/wardrobe load**: agent stays SILENT. Never auto-recommend.

**Mandatory acknowledgment**: before EVERY tool call, model MUST speak first to repeat back the user's request.

**Accessory descriptions**: BANNED generic terms ("delicate earrings", "thin bracelet", "sparkling necklace"). Each item needs 5+ descriptive words + reason why it works.

**`TRYON_COMPLETE` on error**: all try-on error handlers (wardrobe.js, results.js, content.js) MUST send `TRYON_COMPLETE` even on failure, otherwise the voice agent stays muted forever.

**Vision-based recommendations** (`/api/recommend`):
- Model: `gemini-3-flash-preview` with `thinkingConfig: { thinkingBudget: 2048 }`
- Two modes: OUTFIT (picks best combination across 6 categories) and SEARCH (ranks individual items)
- Do NOT change the model or remove thinking mode

## Tests
- Run: `cd backend && npm test`
- `__tests__/outfitBuilder.test.js` — validates 6-category search, concurrency limiter, outfit try-on with 7 images, URL param parsing, ASIN extraction
- `__tests__/circuitBreaker.test.js` — validates circuit breaker state machine
- `__tests__/validation.test.js` — validates image payload validation
- `__tests__/voiceAgent.test.js` — validates voice agent tool declarations (12 tools), system prompt, `buildSystemInstruction()`, and `getClientConfig()`
