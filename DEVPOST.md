# Gemini TryOnMe Everything

AI-powered universal virtual try-on Chrome extension that works on ANY shopping website — Amazon, SHEIN, Temu, Google Shopping — with a real-time voice AI fashion stylist (Giselle) powered by Gemini Live API, AI smart search with Playwright, a 6-category outfit builder, cosmetics/accessories virtual try-on, video animation, and vision-based product recommendations — all powered by Google's Gemini ecosystem and deployed serverless on Google Cloud Run.

## Inspiration

Online shopping has a fundamental problem: you can't try anything on. Return rates for clothing hover around 30-40%, costing the industry billions and generating massive textile waste. I watched people — myself included — endlessly scrolling product pages, trying to imagine how a dress or jacket would actually look on their body. The existing "virtual try-on" solutions are locked to single retailers, require specific poses, and never actually look like *you*.

I thought — what if AI could make every shopping website a fitting room? What if you could try on a dress on Amazon, swap the color on SHEIN, build a complete outfit with accessories from Temu, and have a personal AI stylist who can actually *see* the products and recommend what flatters your skin tone and body type — all from one Chrome extension? And what if that stylist could talk to you in real-time, hands-free, while you browse? That's what I built.

## What it does

Gemini TryOnMe Everything is a Chrome extension that transforms any shopping website into a virtual fitting room, powered entirely by Google's Gemini models:

- **Universal Virtual Try-On**: Click "Try It On" on any product page across Amazon, SHEIN, Temu, or Google Shopping. The extension detects the product type (top, bottom, dress, shoes), extracts the garment image, removes backgrounds, and generates a photorealistic image of YOU wearing that item — preserving your identity, body type, and proportions using multi-reference AI generation with `gemini-3-pro-image-preview`.

- **AI Smart Search**: Type natural language queries like "green cocktail dresses" or "vintage leather jackets" and get 20+ curated, AI-filtered results with prices, ratings, and direct try-on buttons — powered by a Playwright-based agent that navigates Amazon in a headless browser on Cloud Run.

- **6-Category Outfit Builder**: Describe a complete outfit — top, bottom, shoes, necklace, earrings, bracelet — and the system searches all 6 categories in parallel, displays items in a visual wardrobe (hangers for clothes, rack for shoes, ceiling bar for accessories), lets you mix and match, then generates a single try-on image with ALL selected garments in one Gemini call.

- **Giselle — Voice AI Fashion Stylist**: A real-time voice assistant powered by `gemini-2.5-flash-native-audio-latest` via the Gemini Live API. Giselle can search for products, trigger try-ons, build outfits, recommend items based on visual analysis of your body and the products, select specific items by number, save favorites, and generate videos — all through natural conversation. She speaks with personality, remembers your preferences, and supports multiple languages.

- **Vision-Based Recommendations**: When you ask Giselle "which one should I try?", the system captures a screenshot of the search results, sends it along with your profile photo to `gemini-2.5-flash` for visual analysis, and returns personalized recommendations based on your skin tone, body type, and color harmony — referencing specific item numbers with detailed reasoning.

- **Voice-Controlled Item Selection**: Say "try on number 3" or "select top 2" and Giselle highlights the item with an orange outline, scrolls it into view, and triggers the try-on — no clicking needed.

- **Cosmetics Virtual Try-On**: Try lipstick, eyeshadow, blush, foundation, eyeliner, and mascara on your actual face photo using AI inpainting with `gemini-2.5-flash-image`.

- **Accessories Placement**: Necklaces, earrings, and bracelets are placed naturally on your photo with AI-matched lighting and shadows.

- **Video Animation**: Generate 6-second modeling videos of yourself wearing the outfit, with natural movement and fabric flow.

- **Smart Conflict Resolution**: Wearing a dress and trying on a top? The AI detects the conflict, removes the dress, generates a matching bottom, and preserves your identity throughout.

- **Profile with AI-Generated Poses**: Upload 5 photos (3 body + 2 face), and Gemini generates 3 professional model poses of you using identity-preserving multi-reference generation. Choose your favorite pose for all try-ons.

## How I built it

The architecture is a three-tier system with Gemini at the core of every intelligent decision:

**Chrome Extension (Manifest V3)** — Content scripts inject try-on buttons into Amazon, SHEIN, Temu, and Google Shopping product pages. A background service worker handles message routing, tab screenshot capture, and voice command forwarding. The popup/side panel manages user auth, profile, favorites, videos, smart search, outfit builder, and the Giselle voice panel.

**Node.js Backend (Express on Google Cloud Run)** — The brain. All Gemini calls route through here, keeping API keys secure server-side. Handles 14 API route groups including try-on (single + outfit), cosmetics, accessories, video generation, smart search, recommendations, profile management, favorites, and sharing. A WebSocket server at `/ws/voice-live` bridges the Chrome extension to Gemini's Live API for real-time voice streaming.

**Python Smart Search Service** — A Playwright-based agent that navigates Amazon in a headless Chromium browser, executes searches, and extracts product data. Runs as a child process on Cloud Run with a concurrency limiter (MAX_CONCURRENT = 2) to prevent OOM crashes — each browser instance uses ~400MB of memory.

**Key Gemini integration points**:

| Task | Model | Notes |
|---|---|---|
| Virtual try-on (single + outfit) | `gemini-3-pro-image-preview` | Multi-reference identity preservation, 7 images for outfit |
| Background removal & inpainting | `gemini-2.5-flash-image` | Garment extraction, cosmetics, accessories |
| Voice agent (Giselle) | `gemini-2.5-flash-native-audio-latest` | Gemini Live API, bidirectional audio, 12 tools |
| Vision recommendations | `gemini-2.5-flash` | Analyzes user photo + product screenshot |
| Product classification | `gemini-2.5-flash` | Detects garment type, outfit conflicts |

**Infrastructure**: Google Cloud Run (4Gi memory, 2 CPU, 600s timeout), Google Cloud Storage (photos, videos), Google Cloud Firestore (profiles, favorites, video metadata), Firebase Auth (JWT tokens), Gmail SMTP (email sharing).

The critical architectural decision was using Gemini's native audio model for the voice agent instead of a text-to-speech cascade — this gives Giselle natural conversational fluency with sub-second response times, and the same session supports tool calling, transcription, and session resumption.

## Challenges I ran into

**Voice agent 1008 disconnections**: The Gemini Live API with `gemini-2.5-flash-native-audio-latest` disconnected immediately with error code 1008 ("Operation is not implemented"). After extensive debugging, I discovered that passing `sessionResumption: { handle: null }` on the initial connection caused the native audio model to reject the session. The fix was subtle: pass an empty object `{}` for the first connection, and only include the handle when resuming. This single-line fix (`sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {}`) resolved hours of debugging.

**Vision in the Live API doesn't work reliably for recommendations**: I initially tried sending product screenshots directly to the Gemini Live audio session via `sendClientContent`, expecting Giselle to "see" the products. The native audio model acknowledged receiving images but couldn't reliably analyze them for recommendations. The solution: use a separate `gemini-2.5-flash` vision call via a dedicated `/api/recommend` endpoint — the vision model analyzes the user's photo and product screenshot, returns structured JSON recommendations, and the text result is fed back to Giselle as a tool response.

**Gemini drops optional tool parameters**: When building outfits, Gemini's tool calling consistently dropped accessories (necklace, earrings, bracelet) from the `build_outfit` function call, even though the user explicitly mentioned them. I implemented a 3-layer defense: (1) stronger system prompt with explicit parameter examples, (2) bounce-back mechanism that stores pending items and asks again, (3) conversation transcript extraction via regex that recovers accessory mentions from the user's recent messages.

**Identity preservation across 6 garments**: Sending 7 images (user + 6 garments) to Gemini 3 Pro in a single call required careful image ordering — garments first to establish context, face references next, body photo last (closest to the generation prompt) — plus low temperature (0.4) and explicit "identity is priority #1" instructions.

**Smart Search timeout on Cloud Run**: Playwright couldn't find Amazon's search box because datacenter IPs trigger bot detection. Fixed by navigating directly to search results URLs (`amazon.com/s?k=query`) instead of filling the homepage search box.

**OOM crashes with concurrent Playwright browsers**: 6 outfit categories searching simultaneously meant 6 Playwright browsers (~2.4GB total), exceeding Cloud Run's original 2GB limit. Implemented a concurrency limiter (MAX_CONCURRENT = 2) with a queue, and increased Cloud Run memory to 4Gi.

**Temu's React re-renders detaching overlays**: Temu's single-page app framework re-renders DOM nodes during try-on, detaching our injected overlay between the `isConnected` check and the `innerHTML` update. Added a second `isConnected` check after setting content, with automatic re-append to the correct container.

## Accomplishments that I'm proud of

**Universal try-on that actually works across 4 major retailers**: The same extension handles Amazon's server-rendered pages, SHEIN's dynamic React app, Temu's aggressive framework, and Google Shopping's event interception — each requiring different content script strategies but delivering a consistent try-on experience.

**A voice agent that controls the entire shopping flow**: Giselle isn't a chatbot that answers questions — she's an agent that *acts*. She searches for products, selects items by number, builds outfits, triggers try-ons, saves favorites, generates videos, and recommends items based on visual analysis. All through natural voice conversation, with session resumption so the conversation survives network drops.

**Vision-powered personalized recommendations**: The `recommend_items` pipeline — capturing a tab screenshot, sending it with the user's profile photo to Gemini 2.5 Flash, getting back scored recommendations with personal reasoning ("the warm coral tone complements your skin tone") — creates genuinely useful fashion advice, not generic suggestions.

**6-category outfit builder with voice control**: Users can say "build me an outfit with a blue blazer, black pants, white sneakers, gold necklace, and pearl earrings" and the system searches all 6 categories in parallel, renders a visual wardrobe, and lets them select items by voice ("select top 2, bottom 3").

**Multi-reference identity preservation**: The try-on results look like the actual user, not a generic model. The multi-image reference system with anchor images, face close-ups, and careful prompt ordering produces results where users recognize themselves.

## What I learned

**Gemini's native audio model is remarkable but requires precise configuration.** The difference between a working voice agent and a broken one was a single object key (`{ handle: null }` vs `{}`). The Gemini Live API is powerful — native audio generation, tool calling, transcription, session resumption — but the documentation doesn't cover every edge case, and wrong configurations fail silently with generic error codes.

**Vision and audio don't mix well in the same Live session.** I expected the native audio model to process images sent via `sendClientContent`, but it doesn't reliably analyze them for structured tasks. The architecture that works: use the Live session for voice interaction and tool orchestration, but delegate vision tasks to a separate Gemini Flash call. The Live session is the conductor, not the soloist for every modality.

**Gemini's tool calling is powerful but imperfect with optional parameters.** The model excels at calling tools with required parameters but consistently drops optional ones. The lesson: never rely solely on the model to capture all user intent in a single tool call. Implement client-side validation, bounce-back mechanisms, and transcript extraction as fallbacks.

**`gemini-2.5-flash` is the workhorse of production AI.** I used Flash for classification, vision analysis, recommendations, and the voice agent — all at excellent quality with fast response times. I reserved `gemini-3-pro-image-preview` for the computationally intensive try-on generation where image quality is paramount, and `gemini-2.5-flash-image` for background removal and inpainting where speed matters more than artistic nuance.

**Cloud Run is perfect for AI workloads, but memory matters.** Running Playwright browsers, Gemini API calls, and image processing concurrently requires careful memory management. The concurrency limiter pattern — queue requests when at capacity rather than spawning more processes — prevented countless OOM crashes and was simpler than horizontal scaling.

**The Gemini ecosystem is genuinely composable.** Gemini 3 Pro for image generation, Flash Image for processing, native audio for voice, Flash for vision and classification — these share the same SDK (`@google/genai`), the same API patterns, and compose naturally. Building with multiple Gemini models feels like using different tools from the same toolbox, not bolting together separate products.

## What's next for Gemini TryOnMe Everything

- **More retailers**: Expanding content scripts to Zara, H&M, Nordstrom, and other major retailers — the architecture is retailer-agnostic, each new site just needs a content script adapter.
- **Social sharing**: Let users share try-on results and outfit builds directly to Instagram Stories and TikTok with AI-generated captions.
- **Price comparison**: When Giselle recommends an item, automatically find the same or similar item across all supported retailers and show price comparisons.
- **Wardrobe memory**: Let Giselle remember what items the user has tried on and liked, building a style profile that improves recommendations over time.
- **AR preview**: Use the device camera for real-time AR try-on, combining Gemini's generation capabilities with live video overlay.
