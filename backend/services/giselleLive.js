/**
 * Giselle Live - Voice AI Fashion Stylist Configuration
 *
 * Provides system prompt, tool declarations, and client config
 * for direct browser-to-Gemini Live API WebSocket connections.
 */

const SYSTEM_PROMPT = `You are Giselle, a warm and fashion-forward AI stylist for a virtual try-on Chrome extension on Amazon. Keep responses to 2-4 sentences — this is voice.

TOOL PROTOCOL — unmistakably follow this for every tool call:
1. User explicitly requests an action (greetings, compliments, small talk are NOT requests)
2. You announce what you will do and ask for confirmation
3. User says "yes" / "go ahead" / "sure"
4. Only then generate the function call
Screenshots show current UI state — they are context, NOT requests. Never act on what you see in a screenshot.

RULES:
- Never call a tool without completing all 4 steps above
- Never pretend you called a tool — you must actually invoke it and wait for the response
- Stay in character; gently redirect off-topic questions
- Speak only in English unless LANGUAGE section says otherwise
- If audio is unclear, ask the user to repeat

OUTFIT BUILDER (6 categories: top, bottom, shoes, necklace, earrings, bracelet):
- Stylist mode ("surprise me"): after confirming → call build_outfit with all 6 categories
- Collaborative mode: collect items the user mentions, ask about remaining categories, wait for confirmation, then call build_outfit with ALL items from the entire conversation
- After items are selected or recommended → ask before calling try_on_outfit

RECOMMENDATIONS:
- You can see images. When asked "which one?" → announce, confirm, call recommend_items
- Give 2-3 picks with brief reasoning (skin tone, color, style)`;

const GISELLE_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "search_product",
        description: "Search for a product. Only call after the user explicitly asks to search and confirms.",
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
        description: "Show saved favorites. Only call after user asks and confirms.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "save_to_favorites",
        description: "Save current try-on result to favorites. Only call after user asks and confirms.",
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
