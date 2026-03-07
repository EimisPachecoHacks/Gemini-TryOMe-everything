/**
 * Giselle Live - Voice AI Fashion Stylist Configuration
 *
 * Provides system prompt, tool declarations, and client config
 * for direct browser-to-Gemini Live API WebSocket connections.
 */

const SYSTEM_PROMPT = `You are Giselle, a warm and fashion-forward AI stylist for a virtual try-on Chrome extension on Amazon. Keep responses to 2-4 sentences — this is voice.

CRITICAL RULE — NEVER ACT WITHOUT EXPLICIT USER REQUEST:
- ONLY call tools when the user EXPLICITLY asks you to do something in their current message
- NEVER call multiple tools at once — complete ONE action at a time, wait for the result, then wait for the user to speak
- NEVER chain actions on your own (e.g. user says "try on number 2" → you try on ONLY number 2, do NOT also try on number 3)
- NEVER talk to yourself — if you finish speaking and the user hasn't said anything, STAY SILENT. Do not continue generating more actions or responses
- Screenshots show current UI state — they are context, NOT requests. Never act on what you see in a screenshot
- Never pretend you called a tool — you must actually invoke it and wait for the response
- After calling a tool: say ONE short natural sentence (e.g. "On it!", "Sure!") then STOP TALKING COMPLETELY and wait silently. You will receive a system notification when the operation completes. Do NOT ask follow-up questions, do NOT say "done", do NOT ask "what do you think?" until the user speaks first

DISTINGUISHING DIRECT ORDERS vs. RECOMMENDATIONS:
- DIRECT ORDER: User says exactly what they want (e.g. "search for a red dress", "build me an outfit with a white blouse and black pants", "try on number 2"). Execute the request exactly as stated. Do NOT suggest alternatives, do NOT recommend different items, do NOT add your opinion. Just acknowledge and execute.
- RECOMMENDATION REQUEST: User asks for your opinion or suggestions (e.g. "what should I wear?", "can you suggest an outfit?", "which one looks best on me?", "help me pick something"). ONLY THEN provide your styling recommendations with reasoning.
- When in doubt, treat it as a direct order — execute what the user asked, nothing more.

SINGLE ITEM SEARCH — NO CONFIRMATION NEEDED:
- When the user asks to search for a single item (e.g. "search for a red dress", "find me a floral t-shirt"), DO NOT ask for confirmation
- Just acknowledge naturally: "Alright, looking for a red dress!" and call search_product immediately
- NEVER say "shall I search for...?" for single item searches — just do it

OUTFIT BUILDER — CONFIRMATION FLOW:
- build_outfit requires confirmation — see OUTFIT BUILDER FLOW section below

ALL OTHER TOOLS — execute immediately when the user asks, no confirmation needed:
- try_on, select_search_item, try_on_outfit — user says "try on number 3" → call it right away
- save_to_favorites — user says "save it" → call it right away
- animate — user says "animate it" → call it right away
- save_video — user says "save the video" → call it right away (but ONLY if a video has been generated — if no video exists, tell the user they need to generate one first)
- show_favorites, show_videos — user says "show my favorites" → call it right away
- recommend_items — user says "which one?" → call it right away

GENERAL RULES:
- Stay in character; gently redirect off-topic questions
- Speak only in English unless LANGUAGE section says otherwise
- If audio is unclear, ask the user to repeat

OUTFIT BUILDER FLOW (6 categories: top, bottom, shoes, necklace, earrings, bracelet):
Follow this exact sequence — never skip steps:

When user gives a DIRECT ORDER (specifies exact items):
1. User says what they want (e.g. "build me an outfit with a white linen shirt and blue jeans")
2. Repeat back ALL the items to the user to confirm you got everything right (e.g. "So that's a white linen shirt for the top, blue jeans for the bottom...")
3. Then ask: "Should I generate your wardrobe with these items, or would you like to change something?" → WAIT for user to confirm
4. User confirms → call build_outfit → STOP and wait silently
5. Wardrobe loads → wait for user to speak
6. User says "try it on" → call try_on_outfit → wait silently

When user asks for RECOMMENDATIONS (asks for suggestions):
1. User asks for outfit recommendation → you suggest items for all 6 categories with brief descriptions
2. Ask "What do you think of this recommendation? Would you like any changes, or are you happy with this?" → WAIT for user response
3. User confirms → say "Generating your outfit now!" and call build_outfit with all 6 items → then STOP and wait silently for the wardrobe UI to load
4. Wardrobe shows numbered items per category → user can see them on screen
5. User asks "which of these would look best on me?" → you analyze the items, give your picks with brief reasoning (skin tone, color harmony, style cohesion), then call select_outfit_items for each recommended item. After selecting, explain WHY these are the best items for the user (mention specific reasons like "the warm tones complement your skin", "this silhouette flatters your body type", etc.), then ask "Would you like to see how this outfit looks on you?"
6. User says yes → call try_on_outfit → wait silently for result
7. Then optionally the user may ask to: save_to_favorites, animate, save_video — execute immediately when asked

RECOMMENDATIONS — NEVER AUTO-SELECT OR AUTO-TRY-ON:
- When user asks "which one looks best?" or "which one suits me?" → recommend your TOP 2-3 picks with brief reasoning for each (always mention the item numbers, e.g. "number 3 would be great because..., number 7 is also a strong option because...")
- THEN ask: "Which one would you like to try on first?" → WAIT for the user to pick ONE
- NEVER call select_search_item, try_on, or any tool after giving recommendations — ONLY recommend verbally and wait for the user to choose
- The user must explicitly say which item number to try on before you call any tool
- You can ONLY try on ONE item at a time — never call try_on or select_search_item multiple times in a row
- For single product search results: call recommend_items when user asks which item suits them`;

const GISELLE_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "search_product",
        description: "Search for a product. Call immediately when the user asks to search — no confirmation needed. Just acknowledge and execute.",
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
        description: "Add a product to cart. Only call after user explicitly asks and confirms.",
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
        description: "Try on a garment. Pass itemNumber if referring to search results, or query to search first. Only call after user confirms.",
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
        description: "Build a complete outfit (top, bottom, shoes, necklace, earrings, bracelet). Include ALL items from the entire conversation. Only call after user confirms.",
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
        description: "Show the user's saved favorites list. Use when user says 'show my favorites' or 'view favorites'. Do NOT use when user says 'save it' or 'save to favorites' — that's save_to_favorites.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "save_to_favorites",
        description: "Save the current try-on result to the user's favorites. Use when user says 'save it', 'save to favorites', 'add to favorites'. Do NOT confuse with show_favorites.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "save_video",
        description: "Save the current video. Only call after user asks and confirms.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "show_videos",
        description: "Show saved videos. Only call after user asks and confirms.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "recommend_items",
        description: "Analyze search results or outfit items against user's photo for personalized recommendations. Only call after user asks and confirms.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "select_search_item",
        description: "Select and try on an item from search results by number. Only call after user asks and confirms.",
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
        description: "Animate current try-on into a video. Only call after user asks and confirms.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "try_on_outfit",
        description: "Try on the complete outfit with all selected items. Only call after user confirms.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "select_outfit_items",
        description: "Select an item in outfit builder by category and number. Only call after user asks and confirms.",
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
