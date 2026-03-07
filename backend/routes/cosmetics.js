const express = require("express");
const router = express.Router();
const { optionalAuth } = require("../middleware/auth");
const { getProfile } = require("../services/firestore");
const storage = require("../services/storage");
const { validateBase64Image } = require("../middleware/validation");
const { GoogleGenAI } = require("@google/genai");
const { withCircuitBreaker } = require("../services/circuitBreaker");
const { withTimeout } = require("../services/withTimeout");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || "120000", 10);

let genaiClient = null;
function getClient() {
  if (!genaiClient) {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set in environment variables");
    genaiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  }
  return genaiClient;
}

// Supported cosmetic types
const COSMETIC_TYPES = ["lipstick", "eyeshadow", "blush", "foundation", "eyeliner", "mascara"];

router.post("/", optionalAuth, async (req, res, next) => {
  try {
    let { faceImage, cosmeticType, color, productImage } = req.body;
    console.log(`[cosmetics] Request — cosmeticType: ${cosmeticType}, color: ${color}, hasProductImage: ${!!productImage}`);

    // If authenticated and no faceImage provided, fetch from Cloud Storage
    if (!faceImage && req.userId) {
      const profile = await getProfile(req.userId);
      if (profile && profile.facePhotoKey) {
        faceImage = await storage.downloadFileBase64(profile.facePhotoKey);
      }
    }

    if (!faceImage || !cosmeticType) {
      return res.status(400).json({ error: "faceImage and cosmeticType are required" });
    }

    const imgCheck = validateBase64Image(faceImage);
    if (!imgCheck.valid) {
      return res.status(400).json({ error: `Invalid faceImage: ${imgCheck.error}` });
    }

    const type = cosmeticType.toLowerCase();
    if (!COSMETIC_TYPES.includes(type)) {
      return res.status(400).json({ error: `Unsupported cosmetic type. Supported: ${COSMETIC_TYPES.join(", ")}` });
    }

    console.log(`[cosmetics] Processing with Gemini Flash - type: ${type}, color: ${color}, hasProductImage: ${!!productImage}, authenticated: ${!!req.userId}`);

    const client = getClient();

    // Build prompt parts — include product image as color reference if available
    const parts = [];

    parts.push({ text: "FIRST IMAGE — this is the person's face. Apply makeup to this EXACT person:" });
    parts.push({
      inlineData: { mimeType: "image/jpeg", data: faceImage },
    });

    if (productImage) {
      // Strip data URL prefix if present
      const cleanProduct = productImage.startsWith("data:") ? productImage.split(",")[1] : productImage;
      parts.push({ text: "SECOND IMAGE — this is the cosmetic product. Match the EXACT color and finish shown in this product image:" });
      parts.push({
        inlineData: { mimeType: "image/jpeg", data: cleanProduct },
      });
    }

    const colorRef = productImage
      ? `Match the EXACT color, shade, and finish visible in the product image (second image).${color ? ` The color name "${color}" is just a hint — the product image is the true color reference.` : ""}`
      : `Apply ${color || "natural"} color.`;

    parts.push({ text: `You are a professional makeup artist AI. Apply ${type} to the person in the first image.

RULES:
- ${colorRef}
- Apply ONLY ${type} — do NOT apply any other makeup products
- The result must look natural and photorealistic, like a professional makeup application
- Preserve the person's identity EXACTLY — same face, same skin tone, same hair, same everything
- CRITICAL FRAMING: Output the image at the EXACT SAME dimensions, angle, crop, and composition as the input face photo. Do NOT zoom in, do NOT crop tighter, do NOT change the framing. The output must show everything visible in the original photo — full head, hair, shoulders if they were visible
- Keep the same lighting and background
- Do NOT change the person's expression, pose, or any other facial features

OUTPUT FORMAT: First output the image, then output EXACTLY one line of text in this format:
COLORS: <recommend 3-4 specific ${type} color names that would complement this person's skin tone, undertone, and features, separated by commas>

Analyze the person's skin tone (fair, light, medium, olive, tan, deep, etc.) and undertone (warm, cool, neutral) to recommend the most flattering ${type} colors for them specifically. Be specific with color names (e.g. "warm nude", "berry mauve", "coral pink", "deep plum").` });

    const response = await withCircuitBreaker("gemini", () => withTimeout(client.models.generateContent({
      model: "gemini-2.5-flash-image",
      contents: [{ role: "user", parts }],
      config: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    }), GEMINI_TIMEOUT_MS, "cosmetics"));

    const candidates = response.candidates || [];
    if (!candidates.length) {
      throw new Error("No response from Gemini for cosmetics try-on");
    }

    const responseParts = candidates[0].content?.parts || [];
    let resultImage = null;
    let recommendedColors = null;
    for (const part of responseParts) {
      if (part.inlineData) {
        console.log(`[cosmetics] Gemini response received — image: ${part.inlineData.data.length} chars`);
        resultImage = part.inlineData.data;
      }
      if (part.text) {
        console.log(`[cosmetics] Gemini text response: ${part.text}`);
        const colorsMatch = part.text.match(/COLORS:\s*(.+)/i);
        if (colorsMatch) {
          recommendedColors = colorsMatch[1].trim().split(/,\s*/).map(c => c.trim()).filter(Boolean);
        }
      }
    }

    if (!resultImage) throw new Error("No image in Gemini cosmetics response");

    res.set("Cache-Control", "no-store");
    return res.json({ resultImage, originalImage: faceImage, recommendedColors });
  } catch (error) {
    console.error(`[cosmetics] Error:`, error.message);
    next(error);
  }
});

module.exports = router;
