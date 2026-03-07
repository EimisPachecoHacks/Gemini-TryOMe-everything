/**
 * Recommend Route — Vision-based product recommendations
 *
 * Uses Gemini vision model to analyze user photo + search results screenshot
 * and provide personalized style recommendations.
 *
 * Supports two modes:
 * 1. Smart Search mode: recommend individual items from search results
 * 2. Outfit Builder mode: recommend best combination of items across 6 categories
 */

const express = require("express");
const { GoogleGenAI } = require("@google/genai");
const { withCircuitBreaker } = require("../services/circuitBreaker");

const router = express.Router();

let genaiClient = null;
function getClient() {
  if (!genaiClient) genaiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return genaiClient;
}

/**
 * POST /api/recommend
 * Body: { userPhoto (base64), screenshot (base64), products ([{number, title, price, rating}]), userProfile ({sex, clothesSize}), outfitMode (bool), outfitItems ({category: [{number, title, price}]}) }
 * Returns: { recommendations: [{number, score, reason}] } OR { outfitCombination: {category: {number, reason}}, overallReason: string }
 */
router.post("/", async (req, res, next) => {
  try {
    const { userPhoto, screenshot, products, userProfile, outfitMode, outfitItems } = req.body;

    const sex = userProfile?.sex || "unknown";
    const size = userProfile?.clothesSize || "unknown";

    const ai = getClient();
    const parts = [];

    // 1. User photo (if available)
    if (userPhoto) {
      parts.push({
        inlineData: {
          data: userPhoto.startsWith("data:") ? userPhoto.split(",")[1] : userPhoto,
          mimeType: "image/jpeg",
        },
      });
      parts.push({ text: "IMAGE 1: This is the USER's body photo. Analyze their body type, skin tone, and overall style.\n" });
    }

    // 2. Screenshot (if available)
    if (screenshot) {
      const screenshotData = screenshot.startsWith("data:") ? screenshot.split(",")[1] : screenshot;
      parts.push({
        inlineData: {
          data: screenshotData,
          mimeType: "image/jpeg",
        },
      });
      parts.push({
        text: `IMAGE ${userPhoto ? "2" : "1"}: This is a screenshot of the ${outfitMode ? "outfit builder" : "search results"} page showing the products visually.\n`,
      });
    }

    if (outfitMode && outfitItems) {
      // --- OUTFIT BUILDER MODE ---
      const categoryLists = Object.entries(outfitItems)
        .filter(([, items]) => items && items.length > 0)
        .map(([cat, items]) => {
          const itemList = items.map((p) =>
            `  #${p.number}: "${p.title}" — ${p.price || "no price"}`
          ).join("\n");
          return `${cat.toUpperCase()} (${items.length} items):\n${itemList}`;
        }).join("\n\n");

      const totalItems = Object.values(outfitItems).reduce((sum, arr) => sum + (arr?.length || 0), 0);

      parts.push({
        text: `The user is building an outfit. Here are all available items organized by category:\n\n${categoryLists}\n\nThe user is ${sex}, size ${size}.\n\nYour task: Recommend the BEST combination of items — pick ONE item per category that creates the most cohesive, flattering outfit for this person.\n\nConsider:\n- Color coordination across all pieces\n- Style consistency (casual/formal/sporty)\n- How each piece flatters the user's body type and skin tone\n- Pattern mixing rules\n- Accessory coordination with the main outfit pieces\n\nReturn a JSON object with this EXACT structure:\n{\n  "outfitCombination": {\n    "top": { "number": 2, "reason": "The emerald green V-neck complements your warm skin tone" },\n    "bottom": { "number": 1, "reason": "Dark wash jeans create a balanced silhouette" },\n    "shoes": { "number": 3, "reason": "White sneakers keep it casual and match the top's vibe" },\n    "necklace": { "number": 1, "reason": "Gold pendant picks up the warm tones" },\n    "earrings": { "number": 2, "reason": "Simple studs don't compete with the necklace" },\n    "bracelets": { "number": 1, "reason": "Gold bangle ties in with the necklace" }\n  },\n  "overallReason": "This outfit creates a cohesive casual-chic look with warm earth tones that complement your complexion"\n}\n\nOnly include categories that have items available. Be specific about WHY each pick works WITH the other items.\n\nIMPORTANT: Return ONLY valid JSON, no additional text.`,
      });

      console.log(`[recommend] OUTFIT MODE: ${totalItems} items across ${Object.keys(outfitItems).filter(k => outfitItems[k]?.length > 0).length} categories, userPhoto: ${!!userPhoto}, screenshot: ${!!screenshot}, user: ${sex} size ${size}`);

      const response = await withCircuitBreaker("gemini", () => ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: "You are an expert personal stylist AI specializing in building complete outfits. You analyze a person's photo and product selections to recommend the best combination of items that work together as a cohesive outfit. You consider body type, skin tone, color theory, style consistency, and accessory coordination. Your recommendations are specific to the person — never generic.",
          temperature: 0.3,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }));

      const responseText = response.text || "";

      let result;
      try {
        const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonStr = jsonMatch ? jsonMatch[1].trim() : responseText.trim();
        result = JSON.parse(jsonStr);
      } catch {
        const objMatch = responseText.match(/\{[\s\S]*\}/);
        if (objMatch) {
          result = JSON.parse(objMatch[0]);
        } else {
          console.error("[recommend] Outfit parse error:", responseText);
          result = { outfitCombination: null, overallReason: "Could not analyze items properly" };
        }
      }

      res.json(result);
    } else {
      // --- SMART SEARCH MODE ---
      if (!screenshot) {
        return res.status(400).json({ error: "Screenshot is required" });
      }

      const productList = (products || [])
        .map((p) => `#${p.number}: "${p.title}" — ${p.price || "no price"}${p.rating ? ` — ${p.rating} stars` : ""}`)
        .join("\n");

      parts.push({
        text: `Here are ALL ${(products || []).length} products to analyze:\n\n${productList}\n\nBased on the user's photo${userPhoto ? " (IMAGE 1)" : ""} and the results page screenshot, recommend which items would look best on this person. Consider body type, skin tone, color harmony, style compatibility, and value (ratings).\n\nThe user is ${sex}, size ${size}.\n\nReturn a JSON array of the TOP 3-5 best matches sorted from BEST to WORST:\n[\n  { "number": 3, "score": 9, "reason": "The warm coral tone beautifully complements your skin, and the V-neck flatters your frame" },\n  { "number": 1, "score": 7, "reason": "Classic cut works well, but the cool white might wash you out slightly" }\n]\n\nScore 1-10. Reasons should be personal and specific to THIS user's appearance. Be like an honest stylist friend.\n\nIMPORTANT: Return ONLY valid JSON array, no additional text.`,
      });

      console.log(`[recommend] SEARCH MODE: ${(products || []).length} products, userPhoto: ${!!userPhoto}, user: ${sex} size ${size}`);

      const response = await withCircuitBreaker("gemini", () => ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: "You are an expert personal stylist AI. You analyze a person's photo and product images to give honest, personalized fashion recommendations. You consider body type, skin tone, face shape, current style, and color theory. Your recommendations are specific to the person — never generic.",
          temperature: 0.3,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }));

      const responseText = response.text || "";

      let recommendations;
      try {
        const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonStr = jsonMatch ? jsonMatch[1].trim() : responseText.trim();
        recommendations = JSON.parse(jsonStr);
      } catch {
        const arrayMatch = responseText.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          recommendations = JSON.parse(arrayMatch[0]);
        } else {
          console.error("[recommend] Parse error:", responseText);
          recommendations = [{ number: 1, score: 5, reason: "Could not analyze images properly" }];
        }
      }

      res.json({ recommendations });
    }
  } catch (err) {
    console.error("[recommend] Error:", err.message);
    next(err);
  }
});

module.exports = router;
