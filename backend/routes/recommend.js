/**
 * Recommend Route — Vision-based product recommendations
 *
 * Uses Gemini vision model to analyze user photo + search results screenshot
 * and provide personalized style recommendations.
 */

const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const router = express.Router();

let genaiClient = null;
function getClient() {
  if (!genaiClient) genaiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return genaiClient;
}

/**
 * POST /api/recommend
 * Body: { userPhoto (base64), screenshot (base64), products ([{number, title, price, rating}]), userProfile ({sex, clothesSize}) }
 * Returns: { recommendations: [{number, score, reason}] }
 */
router.post("/", async (req, res, next) => {
  try {
    const { userPhoto, screenshot, products, userProfile } = req.body;

    if (!screenshot) {
      return res.status(400).json({ error: "Screenshot is required" });
    }

    const sex = userProfile?.sex || "unknown";
    const size = userProfile?.clothesSize || "unknown";

    // Build multimodal content parts
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

    // 2. Search results screenshot
    const screenshotData = screenshot.startsWith("data:") ? screenshot.split(",")[1] : screenshot;
    parts.push({
      inlineData: {
        data: screenshotData,
        mimeType: "image/jpeg",
      },
    });
    parts.push({
      text: `IMAGE ${userPhoto ? "2" : "1"}: This is a screenshot of the search results page showing all the products. Each product has a numbered badge, image, title, and price visible. Use this to visually assess the colors, styles, and patterns of each product.\n`,
    });

    // 3. Structured product data
    const productList = (products || [])
      .map((p) => `#${p.number}: "${p.title}" — ${p.price || "no price"}${p.rating ? ` — ${p.rating} stars` : ""}`)
      .join("\n");

    parts.push({
      text: `Here are ALL ${(products || []).length} products to analyze:\n\n${productList}\n\nBased on the user's photo${userPhoto ? " (IMAGE 1)" : ""} and the results page screenshot, recommend which items would look best on this person. Consider body type, skin tone, color harmony, style compatibility, and value (ratings).\n\nThe user is ${sex}, size ${size}.\n\nReturn a JSON array of the TOP 3-5 best matches sorted from BEST to WORST:\n[\n  { "number": 3, "score": 9, "reason": "The warm coral tone beautifully complements your skin, and the V-neck flatters your frame" },\n  { "number": 1, "score": 7, "reason": "Classic cut works well, but the cool white might wash you out slightly" }\n]\n\nScore 1-10. Reasons should be personal and specific to THIS user's appearance. Be like an honest stylist friend.\n\nIMPORTANT: Return ONLY valid JSON array, no additional text.`,
    });

    console.log(`[recommend] Analyzing ${(products || []).length} products, userPhoto: ${!!userPhoto}, user: ${sex} size ${size}`);

    const ai = getClient();
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ role: "user", parts }],
      config: {
        systemInstruction: "You are an expert personal stylist AI. You analyze a person's photo and product images to give honest, personalized fashion recommendations. You consider body type, skin tone, face shape, current style, and color theory. Your recommendations are specific to the person — never generic.",
        maxOutputTokens: 2048,
        temperature: 0.3,
      },
    });

    const responseText = response.text || "";

    // Parse JSON from response
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
  } catch (err) {
    console.error("[recommend] Error:", err.message);
    next(err);
  }
});

module.exports = router;
