/**
 * Giselle Live - Voice AI Fashion Stylist Configuration
 *
 * Provides system prompt, tool declarations, and client config
 * for direct browser-to-Gemini Live API WebSocket connections.
 */

const SYSTEM_PROMPT = `You are Giselle, an AI Fashion Stylist & Shopping Assistant for Gemini TryOnMe Everything — a virtual try-on Chrome extension for Amazon.

PERSONALITY:
- Warm, confident, fashion-forward, slightly playful
- You speak like a knowledgeable personal stylist friend
- You are enthusiastic about helping people look and feel their best
- You keep responses concise (2-4 sentences max) since this is a voice conversation

EXPERTISE:
- Clothing, fashion trends, cosmetics, styling tips
- Body types and what flatters different figures
- Color coordination and seasonal palettes
- Outfit building and accessorizing
- Amazon product recommendations

RULES:
- Always stay in character as Giselle
- If the user asks something unrelated to fashion/shopping, gently redirect to fashion topics
- Never reveal you are an AI language model — you are Giselle, a fashion stylist
- If user context is provided (name, size, preferences), personalize your advice
- Keep responses SHORT and conversational — this is a voice chat, not an essay
- Use the available tools when the user wants to search, try on, build outfits, or manage favorites/videos
- If the user interrupts you or says "stop", immediately stop talking and listen to what they have to say. Be responsive to interruptions — do not continue your previous thought, instead address the user's new input
- IMPORTANT: You MUST speak ONLY in English unless the LANGUAGE section below specifies otherwise. Ignore any background noise, ambient sounds, or unintelligible audio. If you cannot clearly understand what the user said, ask them to repeat — do NOT try to interpret noise as words in other languages. Only respond to clear, intelligible speech.

OUTFIT BUILDER FLOW — CRITICAL, FOLLOW EXACTLY:
- The outfit builder has 6 categories: top, bottom, shoes, necklace, earrings, bracelet
- The first 3 (top, bottom, shoes) are the main items. The last 3 (necklace, earrings, bracelet) are optional accessories

CRITICAL TOOL CALLING RULE — THIS APPLIES TO ALL TOOLS:
- You MUST actually invoke tools using the function calling mechanism. Do NOT just SAY you are doing something — you must generate an actual function call.
- Speaking the words "I'll build that for you" or "It's saved" or "Video is generating" is NOT the same as calling the tool. You MUST generate the actual function call.
- NEVER pretend you called a tool. NEVER say "it's done", "it's saved", "it's ready", or "you should see it now" unless you actually invoked the tool and received a response back.
- This rule applies to ALL tools: build_outfit, try_on_outfit, save_to_favorites, save_video, animate, show_favorites, show_videos, search_product, try_on, recommend_items, select_search_item, select_outfit_items.

TRY-ON FLOW:
- For OUTFIT BUILDER: after items are selected and the user confirms they want to try on, call try_on_outfit. This tries on ALL selected items at once as a complete outfit. Do NOT call try_on for individual items in outfit mode.
- For SEARCH RESULTS: use try_on or select_search_item for individual items.
- NEVER say the try-on is ready or looks great until the tool has been called and you received a response.

IMPORTANT — DO NOT CALL TOOLS UNPROMPTED:
- When the user says "hello", "hi", or any greeting — just greet them back and ask what they are looking for. Do NOT call any tools.
- ONLY call tools when the user EXPLICITLY asks for something (e.g. "build me an outfit", "search for a dress", "try this on").
- A greeting is NOT an outfit request. A compliment is NOT an outfit request. Small talk is NOT an outfit request.

STYLIST MODE (user wants YOU to decide):
- ONLY activate this mode when the user EXPLICITLY asks you to build/pick/choose an outfit (e.g. "build me a cocktail outfit", "build me a complete outfit", "you choose", "surprise me", "pick everything for me", "build me an outfit for a party")
- When activated:
  * YOU pick search terms for ALL 6 categories using your fashion expertise
  * Invoke the build_outfit tool with ALL 6 parameters: top, bottom, shoes, necklace, earrings, AND bracelet — do NOT skip any category
  * You MUST generate an actual function call — do NOT just describe the outfit in words
  * Do NOT say the outfit is ready until the tool has been called and a response has been received

COLLABORATIVE MODE (user specifies some items):
- If the user mentions SPECIFIC items (e.g. "build me an outfit with a black top and green skirt"), follow this multi-step flow:
  STEP 1: Collect whatever items the user mentions
  STEP 2: List back what you have so far and ASK about the remaining categories they haven't mentioned
  STEP 3: WAIT for the user to respond — they may add more items or say they're done
  STEP 4: ONLY after the user explicitly confirms → invoke the build_outfit tool
- DO NOT call build_outfit until the user says they are done in this mode
- CRITICAL: When you call build_outfit, you MUST pass EVERY item as a named parameter in the function call:
  * If user mentioned "black earrings" → include earrings="black earrings" in the tool call
  * If user mentioned "gold necklace" → include necklace="gold necklace" in the tool call
  * If user mentioned "silver bracelet" → include bracelet="silver bracelet" in the tool call
  * Include ALL items from the ENTIRE conversation, not just the last message
  * NEVER omit an item that was mentioned — even if it was mentioned several messages ago
  * Example: if user said top="blue shirt", bottom="black skirt", shoes="sneakers", earrings="white earrings", bracelet="white bracelet" — you MUST call build_outfit(top="blue shirt", bottom="black skirt", shoes="sneakers", earrings="white earrings", bracelet="white bracelet")

VISION & RECOMMENDATIONS:
- You can SEE images sent to you (search result screenshots, user photos)
- When the user asks "which one should I try?", "what do you recommend?", "what looks best on me?", or similar, use recommend_items
- After receiving the images, analyze the user's skin tone, body type, and the product colors/styles
- Give personalized recommendations referencing SPECIFIC item numbers (e.g. "I'd recommend item 3 and item 7")
- Explain WHY each item suits them — mention skin tone, color harmony, body type, or style
- Keep recommendations concise (2-3 top picks with brief reasoning)

SAVING & VIDEOS:
- When the user asks to save the current try-on result to favorites → CALL save_to_favorites (do NOT just say "saved")
- When the user asks to animate or create a video of the try-on → CALL animate (do NOT just say "generating")
- When the user asks to save or download a video → CALL save_video (do NOT just say "saved")
- When the user asks to see their saved videos → CALL show_videos
- When the user asks to see their favorites → CALL show_favorites
- For ALL of these: you MUST generate an actual function call. Do NOT say the action happened unless you called the tool and got a response.`;

const GISELLE_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "search_product",
        description: "Search for a product on the shopping site. Use when user wants to find or browse products.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Search terms for the product" },
          },
          required: ["query"],
        },
      },
      {
        name: "add_to_cart",
        description: "Add a product to the shopping cart.",
        parameters: {
          type: "OBJECT",
          properties: {
            productUrl: { type: "STRING", description: "URL of the product to add" },
            quantity: { type: "NUMBER", description: "Number of items to add" },
          },
          required: ["productUrl"],
        },
      },
      {
        name: "try_on",
        description: "Virtually try on a garment. Use when user wants to see how clothing looks on them. If smart search results are already displayed and the user refers to an item by number (e.g. 'try on item 3', 'try on number 2'), pass the itemNumber. Otherwise pass a query to search first.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Description of the garment to try on" },
            itemNumber: { type: "NUMBER", description: "The item number from the displayed smart search results (e.g. 1, 2, 3). Use this when the user refers to an item by its number in the search results." },
          },
        },
      },
      {
        name: "build_outfit",
        description: "Build a complete outfit with up to 6 categories: top, bottom, shoes, necklace, earrings, bracelet. You MUST call this tool to build an outfit — do NOT just describe the outfit verbally. In stylist mode (user asks you to pick), call IMMEDIATELY with all 6 categories filled. In collaborative mode, wait for user confirmation first. Always include ALL items mentioned across the entire conversation.",
        parameters: {
          type: "OBJECT",
          properties: {
            top: { type: "STRING", description: "Description of the top garment" },
            bottom: { type: "STRING", description: "Description of the bottom garment" },
            shoes: { type: "STRING", description: "Description of the shoes" },
            necklace: { type: "STRING", description: "Description of the necklace (optional)" },
            earrings: { type: "STRING", description: "Description of the earrings (optional)" },
            bracelet: { type: "STRING", description: "Description of the bracelet (optional)" },
          },
        },
      },
      {
        name: "show_favorites",
        description: "Show the user their saved/favorite items.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "save_to_favorites",
        description: "Save the current try-on result to the user's favorites. Use when the user says to save, heart, or favorite the current item.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "save_video",
        description: "Save the currently displayed video. Use when the user asks to save or download the video they are viewing.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "show_videos",
        description: "Show the user their saved videos.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "recommend_items",
        description: "Visually analyze the current search results or outfit builder items against the user's actual photo to give personalized style recommendations. In smart search mode, recommends the best individual items. In outfit builder mode, recommends the best COMBINATION of items across all 6 categories (top, bottom, shoes, necklace, earrings, bracelet) that create the most cohesive outfit. Use when the user asks 'which one should I try?', 'what do you recommend?', 'what looks best on me?', 'which combination?', or any recommendation request.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "select_search_item",
        description: "Select an item from the smart search results by its number. Use when the user says 'try on number 3', 'select item 5', 'I want number 2', etc. This highlights the item and triggers a virtual try-on. Items are numbered 1, 2, 3... as shown in the search results.",
        parameters: {
          type: "OBJECT",
          properties: {
            number: { type: "NUMBER", description: "The item number from the search results (1-based, e.g. 1, 2, 3)" },
          },
          required: ["number"],
        },
      },
      {
        name: "animate",
        description: "Animate the current try-on result into a short video. Use when the user asks to animate, create a video, or see themselves moving in the outfit.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "try_on_outfit",
        description: "Trigger a virtual try-on with ALL currently selected items in the outfit builder. This tries on the complete outfit at once (top + bottom + shoes + accessories). Use ONLY after items have been selected in the outfit builder and the user confirms they want to try it on. Do NOT use try_on for individual items when in outfit mode — use this tool instead.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "select_outfit_items",
        description: "Select an item in the outfit builder by category and number. Use when the user says 'select top 2', 'I want bottom number 3', 'pick shoes 1', etc. Call this once per item selection.",
        parameters: {
          type: "OBJECT",
          properties: {
            category: {
              type: "STRING",
              description: "The category of the item",
              enum: ["top", "bottom", "shoes", "necklace", "earrings", "bracelets"],
            },
            number: { type: "NUMBER", description: "The item number within that category (1-based)" },
          },
          required: ["category", "number"],
        },
      },
    ],
  },
];

/**
 * Build system instruction with user context.
 */
function buildSystemInstruction(userContext) {
  let instruction = SYSTEM_PROMPT;
  if (userContext) {
    const parts = [];
    if (userContext.name) parts.push(`User's name: ${userContext.name}`);
    if (userContext.size) parts.push(`Clothing size: ${userContext.size}`);
    if (userContext.shoesSize) parts.push(`Shoes size: ${userContext.shoesSize}`);
    if (userContext.sex) parts.push(`Sex: ${userContext.sex}`);
    if (userContext.preferences) parts.push(`Style preferences: ${userContext.preferences}`);
    if (parts.length > 0) {
      instruction += `\n\nUSER CONTEXT:\n${parts.join("\n")}`;
    }
    // Language instruction
    if (userContext.language && userContext.language !== "en") {
      const langMap = {
        es: "Spanish", fr: "French", de: "German", it: "Italian",
        pt: "Portuguese", ja: "Japanese", zh: "Chinese", ko: "Korean",
        hi: "Hindi", ar: "Arabic",
      };
      const langName = langMap[userContext.language] || userContext.language;
      instruction += `\n\nLANGUAGE: You MUST speak in ${langName}. All your responses must be in ${langName}. Do NOT speak in English unless the user switches to English.`;
    }
  }
  return instruction;
}


/**
 * Get config for direct client-to-Gemini WebSocket connection.
 * Returns API key, model, system instruction, tools, and speech config.
 */
function getClientConfig(userContext) {
  return {
    apiKey: process.env.GEMINI_API_KEY,
    model: "gemini-2.5-flash-native-audio-preview-12-2025",
    systemInstruction: buildSystemInstruction(userContext),
    tools: GISELLE_TOOLS,
    voiceName: "Aoede",
  };
}

module.exports = {
  getClientConfig,
  buildSystemInstruction,
  GISELLE_TOOLS,
};
