const { GoogleGenAI } = require("@google/genai");
const { withCircuitBreaker } = require("./circuitBreaker");
const { withTimeout } = require("./withTimeout");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || "60000", 10); // 60s for text-only calls
let genaiClient = null;

function getClient() {
  if (!genaiClient) {
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set in environment variables");
    }
    genaiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  }
  return genaiClient;
}

/**
 * Detect image format from base64 string.
 * Checks decoded magic bytes for reliable detection, with base64 prefix fallback.
 * Gemini requires the correct format — hardcoding "jpeg" fails for PNG images.
 */
function detectImageFormat(base64String) {
  // Try decoding the first few bytes for reliable magic-byte detection
  try {
    const header = Buffer.from(base64String.slice(0, 24), "base64");
    // PNG: 89 50 4E 47
    if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) return "png";
    // JPEG: FF D8 FF
    if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) return "jpeg";
    // WebP: RIFF....WEBP
    if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
        header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) return "webp";
    // GIF: GIF8
    if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x38) return "gif";
    // BMP: BM
    if (header[0] === 0x42 && header[1] === 0x4D) return "bmp";
  } catch {
    // Fallback to base64 prefix matching
  }

  // Base64 prefix fallback (less reliable but still useful)
  if (base64String.startsWith("iVBOR")) return "png";
  if (base64String.startsWith("/9j/")) return "jpeg";
  if (base64String.startsWith("UklG")) return "webp";
  return "jpeg"; // final fallback
}

async function analyzeProduct(imageBase64, title, breadcrumbs) {
  const systemPrompt = `You are a product classification assistant for a virtual try-on shopping app.
Analyze the product image and information provided, then return a JSON response with the following structure:
{
  "category": "clothing" | "footwear" | "cosmetics" | "accessories" | "unsupported",
  "garmentClass": "UPPER_BODY" | "LOWER_BODY" | "FULL_BODY" | "FOOTWEAR" | null,
  "garmentSubClass": "LONG_SLEEVE_SHIRT" | "SHORT_SLEEVE_SHIRT" | "NO_SLEEVE_SHIRT" | "LONG_PANTS" | "SHORT_PANTS" | "LONG_DRESS" | "SHORT_DRESS" | "FULL_BODY_OUTFIT" | "SHOES" | "BOOTS" | null,
  "cosmeticType": "lipstick" | "eyeshadow" | "blush" | "foundation" | "eyeliner" | "mascara" | null,
  "accessoryType": "earrings" | "necklace" | "bracelet" | "ring" | "sunglasses" | "hat" | null,
  "color": "the primary color of the product",
  "styleTips": ["tip1", "tip2", "tip3"]
}

Classification rules:
- Shirts, jackets, hoodies, blouses, tops, sweaters, coats, crop tops → category: "clothing", garmentClass: "UPPER_BODY"
- Pants, jeans, skirts, shorts, leggings → category: "clothing", garmentClass: "LOWER_BODY"
- Dresses, jumpsuits, overalls, rompers (SINGLE connected garment only) → category: "clothing", garmentClass: "FULL_BODY"
- Shoes, boots, sandals, sneakers, heels → category: "footwear", garmentClass: "FOOTWEAR"
- Lipstick, lip gloss, lip color → category: "cosmetics", cosmeticType: "lipstick"
- Eye shadow, eye palette → category: "cosmetics", cosmeticType: "eyeshadow"
- Blush, bronzer, highlighter → category: "cosmetics", cosmeticType: "blush"
- Foundation, concealer, powder, BB cream → category: "cosmetics", cosmeticType: "foundation"
- Eyeliner, eye pencil, kohl → category: "cosmetics", cosmeticType: "eyeliner"
- Mascara, lash product → category: "cosmetics", cosmeticType: "mascara"
- Earrings, ear studs, ear cuffs, hoops → category: "accessories", accessoryType: "earrings"
- Necklace, pendant, chain, choker → category: "accessories", accessoryType: "necklace"
- Bracelet, bangle, wrist chain → category: "accessories", accessoryType: "bracelet"
- Ring, finger ring, band → category: "accessories", accessoryType: "ring"
- Sunglasses, eyeglasses, glasses → category: "accessories", accessoryType: "sunglasses"
- Hat, cap, beanie, headband, headpiece, hair chain, head chain, tiara, hair accessory → category: "accessories", accessoryType: "hat"
- Watches, bags, scarves → category: "unsupported"
- Everything else → category: "unsupported"

CRITICAL classification rules — apply in this EXACT priority order:

RULE 1 — TITLE KEYWORDS OVERRIDE EVERYTHING:
- If the product TITLE contains "jumpsuit", "romper", "playsuit", "overalls", or "catsuit" → category: "clothing", garmentClass: "FULL_BODY", ALWAYS. No exceptions. Even if the image looks like two separate pieces.
- If the product TITLE contains "dress" or "gown" → category: "clothing", garmentClass: "FULL_BODY", ALWAYS.

RULE 2 — TWO-PIECE SETS / MULTI-PIECE OUTFITS (HIGHEST PRIORITY after Rule 1):
- If the product TITLE contains BOTH an upper-body keyword (top, shirt, blouse, hoodie, jacket, sweater, tankini, crop top, vest) AND a lower-body keyword (pants, jeans, skirt, shorts, leggings) → category: "clothing", garmentClass: "FULL_BODY", garmentSubClass: "FULL_BODY_OUTFIT", ALWAYS. Examples: "Tankini Top And Shorts", "Hoodie and Pants Set", "Crop Top with Skirt Two-Piece".
- If the product TITLE contains a set indicator ("set", "two-piece", "two piece", "combo", "outfit", "suit") AND at least one clothing keyword → category: "clothing", garmentClass: "FULL_BODY", garmentSubClass: "FULL_BODY_OUTFIT", ALWAYS.
- This rule applies even if the items are separate pieces — they are sold together and must replace the FULL outfit in try-on.

RULE 3 — SINGLE-PIECE KEYWORDS (only if Rules 1-2 do not apply):
- If the product TITLE contains "top", "shirt", "blouse", "crop top", "hoodie", "jacket", "sweater" → category: "clothing", garmentClass: "UPPER_BODY", even if the image shows matching pants.
- If the product TITLE contains "pants", "jeans", "skirt", "shorts", "leggings" → category: "clothing", garmentClass: "LOWER_BODY", even if the image shows a matching top.

RULE 4 — ACCESSORY TITLE KEYWORDS (applies before RULE 5):
- If the product TITLE mentions what the product IS (e.g. "headpiece", "head chain", "earrings", "necklace", "bracelet", "ring", "sunglasses", "hat", "cap", "headband", "tiara"), classify as category: "accessories" with the appropriate accessoryType. The TITLE is the most reliable signal — trust it over how the image looks.
- NEVER classify a product as "unsupported" if the title clearly indicates it is a wearable accessory.

RULE 5 — AMBIGUOUS (only if title has no keywords from above):
- If the image shows a MATCHING SET (top + bottom sold together) and the title does NOT contain any of the keywords above, classify based on the most prominent piece in the image.

For styleTips, provide 2-3 short, helpful fashion tips about how to style or wear this product.

IMPORTANT: Return ONLY valid JSON, no additional text.`;

  const client = getClient();

  const response = await withCircuitBreaker("gemini", () => withTimeout(client.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [{
      role: "user",
      parts: [
        {
          inlineData: {
            mimeType: `image/${detectImageFormat(imageBase64)}`,
            data: imageBase64,
          },
        },
        {
          text: `Product title: ${title}\nCategory path: ${breadcrumbs}\n\nAnalyze this product for virtual try-on classification. Return JSON only.`,
        },
      ],
    }],
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      temperature: 0.1,
      thinkingConfig: { thinkingBudget: 0 },
    },
  }), GEMINI_TIMEOUT_MS, "analyzeProduct"));

  // Extract the text response (use .text which concatenates all parts properly)
  const responseText = response.text || response.candidates[0].content.parts[0].text;

  // Parse JSON from response (handle potential markdown code blocks)
  let jsonStr = responseText;
  const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("Failed to parse Gemini response:", responseText);
    // Fallback: try to extract JSON object from response
    const objectMatch = responseText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch (_) {}
    }
    // Last resort: return a basic classification based on title keywords
    console.warn("[classifier] analyzeProduct: falling back to title-based classification");
    return classifyByTitle(title);
  }
}

/**
 * Classify what the person is currently wearing in their photo.
 * Used to resolve clothing conflicts in virtual try-on.
 * Returns: { currentType: "FULL_BODY"|"UPPER_LOWER"|"OUTERWEAR", description: string }
 */
async function classifyOutfit(imageBase64) {
  const systemPrompt = `You are a fashion analysis assistant. Analyze what the person in the image is currently wearing and classify their outfit.

Return a JSON response with this structure:
{
  "currentType": "FULL_BODY" | "UPPER_LOWER" | "OUTERWEAR",
  "upperDescription": "description of upper body clothing or null",
  "lowerDescription": "description of lower body clothing or null",
  "fullDescription": "description of full body garment or null",
  "outerwearDescription": "description of outerwear or null"
}

Classification rules:
- FULL_BODY: Person is wearing a SINGLE PIECE garment that covers both upper and lower body. This includes: dresses, jumpsuits, rompers, playsuits, overalls, gowns, one-piece outfits, skort sets that are connected. IMPORTANT: If the top and bottom appear to be the SAME COLOR and SAME FABRIC/MATERIAL, it is very likely a single piece (dress, romper, playsuit) and should be classified as FULL_BODY.
- UPPER_LOWER: Person is wearing CLEARLY SEPARATE and DISTINCT top and bottom pieces that are DIFFERENT garments (e.g. a white shirt with blue jeans, a red blouse with a black skirt). The top and bottom must be visibly different items.
- OUTERWEAR: Person is wearing a coat, jacket, or blazer over other clothing

When in doubt between FULL_BODY and UPPER_LOWER, prefer FULL_BODY if the upper and lower pieces match in color/fabric.

For FULL_BODY: set fullDescription (e.g. "red floral dress", "black jumpsuit", "blue romper")
For UPPER_LOWER: set upperDescription (e.g. "white t-shirt") and lowerDescription (e.g. "blue jeans")
For OUTERWEAR: set outerwearDescription and also set what's underneath if visible

IMPORTANT: Return ONLY valid JSON, no additional text.`;

  const client = getClient();

  const response = await withCircuitBreaker("gemini", () => withTimeout(client.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [{
      role: "user",
      parts: [
        {
          inlineData: {
            mimeType: `image/${detectImageFormat(imageBase64)}`,
            data: imageBase64,
          },
        },
        {
          text: "Analyze what this person is currently wearing. Classify the outfit type and describe each piece. Return JSON only.",
        },
      ],
    }],
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      temperature: 0.1,
      thinkingConfig: { thinkingBudget: 0 },
    },
  }), GEMINI_TIMEOUT_MS, "classifyOutfit"));

  const responseText = response.text || response.candidates[0].content.parts[0].text;

  let jsonStr = responseText;
  const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("Failed to parse outfit classification:", responseText);
    const objectMatch = responseText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return JSON.parse(objectMatch[0]);
    }
    // Fallback: assume separate top+bottom (safest default)
    console.warn("[classifier] classifyOutfit: could not parse response, defaulting to UPPER_LOWER");
    return { currentType: "UPPER_LOWER", upperDescription: null, lowerDescription: null };
  }
}

/**
 * Detect if an image contains a person/model wearing the garment.
 * Used to decide if garment extraction is needed before try-on.
 */
async function hasPersonInImage(imageBase64) {
  const systemPrompt = `You are an image analysis assistant. Analyze the image and determine if it contains a person or human model wearing clothing.

Return a JSON response:
{
  "hasPerson": true | false,
  "garmentDescription": "brief description of the garment" | null
}

Rules:
- hasPerson: true if there is a visible person, human model, or mannequin wearing the garment
- hasPerson: false if the image shows ONLY a garment (flat lay, on hanger, product-only shot, no human body visible)
- garmentDescription: if hasPerson is true, describe the main garment (e.g. "blue denim jacket", "red floral dress")
- garmentDescription: null if hasPerson is false

IMPORTANT: Return ONLY valid JSON, no additional text.`;

  const client = getClient();

  const response = await withCircuitBreaker("gemini", () => withTimeout(client.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [{
      role: "user",
      parts: [
        {
          inlineData: {
            mimeType: `image/${detectImageFormat(imageBase64)}`,
            data: imageBase64,
          },
        },
        {
          text: "Does this image contain a person or model? Return JSON only.",
        },
      ],
    }],
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      temperature: 0.1,
      thinkingConfig: { thinkingBudget: 0 },
    },
  }), GEMINI_TIMEOUT_MS, "hasPersonInImage"));

  const responseText = response.text || response.candidates[0].content.parts[0].text;

  let jsonStr = responseText;
  const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    const objectMatch = responseText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return JSON.parse(objectMatch[0]);
    }
    return { hasPerson: false, garmentDescription: null };
  }
}

/**
 * Fallback classification based on product title keywords.
 * Used when Gemini fails to return valid JSON.
 */
function classifyByTitle(title) {
  const t = (title || "").toLowerCase();

  // Cosmetics
  const cosmeticPatterns = [
    { match: /lipstick|lip\s*(gloss|balm|color|stain|tint)/i, type: "lipstick" },
    { match: /eye\s*shadow|eye\s*palette/i, type: "eyeshadow" },
    { match: /blush|bronzer|highlighter/i, type: "blush" },
    { match: /foundation|concealer|powder|bb\s*cream/i, type: "foundation" },
    { match: /eyeliner|eye\s*pencil|kohl/i, type: "eyeliner" },
    { match: /mascara|lash/i, type: "mascara" },
  ];
  for (const p of cosmeticPatterns) {
    if (p.match.test(t)) {
      return { category: "cosmetics", cosmeticType: p.type, garmentClass: null, color: null, styleTips: [] };
    }
  }

  // Accessories
  const accessoryPatterns = [
    { match: /earring|ear\s*(stud|cuff|hoop)/i, type: "earrings" },
    { match: /necklace|pendant|chain|choker/i, type: "necklace" },
    { match: /bracelet|bangle/i, type: "bracelet" },
    { match: /\bring\b|finger\s*ring/i, type: "ring" },
    { match: /sunglasses|eyeglasses/i, type: "sunglasses" },
  ];
  for (const p of accessoryPatterns) {
    if (p.match.test(t)) {
      return { category: "accessories", accessoryType: p.type, garmentClass: null, color: null, styleTips: [] };
    }
  }

  // Clothing
  if (/jumpsuit|romper|playsuit|overalls|catsuit/i.test(t)) {
    return { category: "clothing", garmentClass: "FULL_BODY", color: null, styleTips: [] };
  }
  if (/dress|gown/i.test(t)) {
    return { category: "clothing", garmentClass: "FULL_BODY", color: null, styleTips: [] };
  }

  // Two-piece sets: if title contains BOTH upper and lower keywords, or set/two-piece/combo indicators,
  // classify as FULL_BODY so the try-on replaces the entire outfit
  const hasUpper = /shirt|blouse|top|hoodie|jacket|sweater|coat|vest|tankini/i.test(t);
  const hasLower = /pants|jeans|skirt|shorts|leggings/i.test(t);
  const hasSetIndicator = /\bset\b|two[\s-]?piece|combo|outfit|suit\b/i.test(t);
  if (hasUpper && hasLower) {
    return { category: "clothing", garmentClass: "FULL_BODY", garmentSubClass: "FULL_BODY_OUTFIT", color: null, styleTips: [] };
  }
  if ((hasUpper || hasLower) && hasSetIndicator) {
    return { category: "clothing", garmentClass: "FULL_BODY", garmentSubClass: "FULL_BODY_OUTFIT", color: null, styleTips: [] };
  }

  if (hasLower && !hasUpper) {
    return { category: "clothing", garmentClass: "LOWER_BODY", color: null, styleTips: [] };
  }
  if (hasUpper && !hasLower) {
    return { category: "clothing", garmentClass: "UPPER_BODY", color: null, styleTips: [] };
  }
  if (/shoe|boot|sandal|sneaker|heel|slipper/i.test(t)) {
    return { category: "footwear", garmentClass: "FOOTWEAR", color: null, styleTips: [] };
  }

  // Default: assume clothing upper body
  return { category: "clothing", garmentClass: "UPPER_BODY", color: null, styleTips: [] };
}

/**
 * Classify a text search query to determine product category and whether
 * size / shoe size / sex should be appended to the search.
 *
 * Uses Gemini for AI classification with classifyByTitle as fallback.
 *
 * @param {string} queryText - The user's search query (e.g. "red summer dress")
 * @returns {Promise<{ category: string, needsClothingSize: boolean, needsShoeSize: boolean, needsSex: boolean }>}
 */
async function classifyQuery(queryText) {
  const systemPrompt = `You are a product search classification assistant. Given a search query, determine what type of product it is.

Return a JSON response:
{
  "category": "clothing" | "footwear" | "cosmetics" | "accessories" | "unsupported",
  "needsClothingSize": true | false,
  "needsShoeSize": true | false,
  "needsSex": true | false
}

Rules:
- clothing (shirts, pants, dresses, jackets, leggings, hoodies, etc.): needsClothingSize=true, needsShoeSize=false, needsSex=true
- footwear (shoes, boots, sneakers, sandals, heels, slippers): needsClothingSize=false, needsShoeSize=true, needsSex=true
- cosmetics (lipstick, foundation, mascara, eyeshadow, skincare, perfume, etc.): all false
- accessories (earrings, necklace, bracelet, ring, sunglasses, watch, bag, hat): all false
- unsupported (electronics, food, furniture, etc.): all false

IMPORTANT: Return ONLY valid JSON, no additional text.`;

  try {
    const client = getClient();
    const response = await withCircuitBreaker("gemini", () => withTimeout(client.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ role: "user", parts: [{ text: `Search query: "${queryText}"\n\nClassify this product search query. Return JSON only.` }] }],
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        maxOutputTokens: 256,
        temperature: 0.0,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }), GEMINI_TIMEOUT_MS, "classifyQuery"));

    const responseText = response.text || response.candidates[0].content.parts[0].text;
    let jsonStr = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        category: parsed.category || "clothing",
        needsClothingSize: !!parsed.needsClothingSize,
        needsShoeSize: !!parsed.needsShoeSize,
        needsSex: !!parsed.needsSex,
      };
    } catch {
      const objectMatch = responseText.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        const parsed = JSON.parse(objectMatch[0]);
        return {
          category: parsed.category || "clothing",
          needsClothingSize: !!parsed.needsClothingSize,
          needsShoeSize: !!parsed.needsShoeSize,
          needsSex: !!parsed.needsSex,
        };
      }
    }
  } catch (err) {
    console.warn("[classifier] classifyQuery AI failed, falling back to title-based:", err.message);
  }

  // Fallback: use regex-based classification
  return classifyQueryByTitle(queryText);
}

/**
 * Fallback regex-based classification for search queries.
 * Mirrors classifyByTitle logic but returns size/sex flags.
 */
function classifyQueryByTitle(text) {
  const t = (text || "").toLowerCase();

  // Cosmetics — no size needed
  if (/lipstick|lip\s*(gloss|balm|color|stain|tint)|eye\s*shadow|eye\s*palette|blush|bronzer|highlighter|foundation|concealer|powder|bb\s*cream|eyeliner|eye\s*pencil|kohl|mascara|lash|perfume|fragrance|skincare|serum|moisturizer|sunscreen/i.test(t)) {
    return { category: "cosmetics", needsClothingSize: false, needsShoeSize: false, needsSex: false };
  }

  // Accessories — no size needed
  if (/earring|ear\s*(stud|cuff|hoop)|necklace|pendant|chain|choker|bracelet|bangle|\bring\b|finger\s*ring|sunglasses|eyeglasses|watch|bag|purse|handbag|hat|scarf|belt/i.test(t)) {
    return { category: "accessories", needsClothingSize: false, needsShoeSize: false, needsSex: false };
  }

  // Footwear — shoe size needed
  if (/shoe|boot|sandal|sneaker|heel|slipper|loafer|mule|flip\s*flop|clog/i.test(t)) {
    return { category: "footwear", needsClothingSize: false, needsShoeSize: true, needsSex: true };
  }

  // Default: clothing — clothing size needed
  return { category: "clothing", needsClothingSize: true, needsShoeSize: false, needsSex: true };
}

module.exports = { analyzeProduct, classifyOutfit, hasPersonInImage, classifyQuery, classifyQueryByTitle };
