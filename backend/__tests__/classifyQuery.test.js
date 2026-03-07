/**
 * Classify Query Tests
 *
 * Tests the query classification logic used by the Compare feature to decide
 * whether to append user size, shoe size, or sex to the search query.
 *
 * Tests classifyQueryByTitle (regex fallback) directly, and the query
 * enrichment logic that runs in popup.js.
 */

const { classifyQueryByTitle } = require("../services/classifier");

// ---------------------------------------------------------------------------
// Replicate the enrichment logic from popup.js for testing
// ---------------------------------------------------------------------------

function enrichQuery(query, classification, profile) {
  const sizeParts = [];

  if (classification.needsSex && profile.sex) {
    const sexLabel = profile.sex === "male" ? "for men" : "for women";
    if (
      !query.toLowerCase().includes("for men") &&
      !query.toLowerCase().includes("for women") &&
      !query.toLowerCase().includes("men's") &&
      !query.toLowerCase().includes("women's")
    ) {
      sizeParts.push(sexLabel);
    }
  }

  if (classification.needsClothingSize && profile.clothesSize) {
    sizeParts.push(`size ${profile.clothesSize}`);
  }

  if (classification.needsShoeSize && profile.shoesSize) {
    sizeParts.push(`size ${profile.shoesSize}`);
  }

  return sizeParts.length > 0 ? `${query} ${sizeParts.join(" ")}` : query;
}

// ---------------------------------------------------------------------------
// Test Suite 1: Query Classification — Clothing
// ---------------------------------------------------------------------------
describe("Classify Query — Clothing", () => {
  const clothingQueries = [
    "red summer dress",
    "blue jeans skinny fit",
    "women's winter jacket",
    "cotton t-shirt casual",
    "black leggings workout",
    "hoodie oversized",
    "denim shorts",
    "long sleeve blouse floral",
    "men's polo shirt",
    "linen pants wide leg",
  ];

  test.each(clothingQueries)('"%s" → clothing', (query) => {
    const result = classifyQueryByTitle(query);
    expect(result.category).toBe("clothing");
    expect(result.needsClothingSize).toBe(true);
    expect(result.needsShoeSize).toBe(false);
    expect(result.needsSex).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test Suite 2: Query Classification — Footwear
// ---------------------------------------------------------------------------
describe("Classify Query — Footwear", () => {
  const footwearQueries = [
    "running shoes nike",
    "leather boots women",
    "summer sandals flat",
    "white sneakers casual",
    "high heel pumps",
    "bedroom slippers cozy",
    "loafer brown leather",
  ];

  test.each(footwearQueries)('"%s" → footwear', (query) => {
    const result = classifyQueryByTitle(query);
    expect(result.category).toBe("footwear");
    expect(result.needsClothingSize).toBe(false);
    expect(result.needsShoeSize).toBe(true);
    expect(result.needsSex).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test Suite 3: Query Classification — Cosmetics
// ---------------------------------------------------------------------------
describe("Classify Query — Cosmetics", () => {
  const cosmeticsQueries = [
    "red lipstick matte",
    "foundation full coverage",
    "mascara waterproof",
    "eyeshadow palette nude",
    "blush rose gold",
    "eyeliner liquid black",
    "lip gloss shiny",
    "perfume floral women",
    "sunscreen spf 50",
    "moisturizer face cream",
  ];

  test.each(cosmeticsQueries)('"%s" → cosmetics', (query) => {
    const result = classifyQueryByTitle(query);
    expect(result.category).toBe("cosmetics");
    expect(result.needsClothingSize).toBe(false);
    expect(result.needsShoeSize).toBe(false);
    expect(result.needsSex).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test Suite 4: Query Classification — Accessories
// ---------------------------------------------------------------------------
describe("Classify Query — Accessories", () => {
  const accessoryQueries = [
    "gold hoop earrings",
    "silver pendant necklace",
    "leather bracelet men",
    "diamond engagement ring",
    "aviator sunglasses polarized",
    "smart watch fitness",
    "crossbody bag leather",
  ];

  test.each(accessoryQueries)('"%s" → accessories', (query) => {
    const result = classifyQueryByTitle(query);
    expect(result.category).toBe("accessories");
    expect(result.needsClothingSize).toBe(false);
    expect(result.needsShoeSize).toBe(false);
    expect(result.needsSex).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test Suite 5: Query Enrichment Logic
// ---------------------------------------------------------------------------
describe("Query Enrichment", () => {
  const femaleProfile = { sex: "female", clothesSize: "M", shoesSize: "8" };
  const maleProfile = { sex: "male", clothesSize: "L", shoesSize: "10" };
  const emptyProfile = {};

  test("clothing query appends sex and clothing size", () => {
    const classification = { category: "clothing", needsClothingSize: true, needsShoeSize: false, needsSex: true };
    const result = enrichQuery("red summer dress", classification, femaleProfile);
    expect(result).toBe("red summer dress for women size M");
  });

  test("footwear query appends sex and shoe size", () => {
    const classification = { category: "footwear", needsClothingSize: false, needsShoeSize: true, needsSex: true };
    const result = enrichQuery("running shoes nike", classification, maleProfile);
    expect(result).toBe("running shoes nike for men size 10");
  });

  test("cosmetics query stays unchanged", () => {
    const classification = { category: "cosmetics", needsClothingSize: false, needsShoeSize: false, needsSex: false };
    const result = enrichQuery("red lipstick matte", classification, femaleProfile);
    expect(result).toBe("red lipstick matte");
  });

  test("accessories query stays unchanged", () => {
    const classification = { category: "accessories", needsClothingSize: false, needsShoeSize: false, needsSex: false };
    const result = enrichQuery("gold hoop earrings", classification, femaleProfile);
    expect(result).toBe("gold hoop earrings");
  });

  test("empty profile — no enrichment even for clothing", () => {
    const classification = { category: "clothing", needsClothingSize: true, needsShoeSize: false, needsSex: true };
    const result = enrichQuery("blue jeans", classification, emptyProfile);
    expect(result).toBe("blue jeans");
  });

  test("does not duplicate sex if already in query", () => {
    const classification = { category: "clothing", needsClothingSize: true, needsShoeSize: false, needsSex: true };
    const result = enrichQuery("women's winter jacket", classification, femaleProfile);
    expect(result).toBe("women's winter jacket size M");
  });

  test("does not duplicate 'for men' if already in query", () => {
    const classification = { category: "clothing", needsClothingSize: true, needsShoeSize: false, needsSex: true };
    const result = enrichQuery("polo shirt for men", classification, maleProfile);
    expect(result).toBe("polo shirt for men size L");
  });

  test("male profile with clothing query", () => {
    const classification = { category: "clothing", needsClothingSize: true, needsShoeSize: false, needsSex: true };
    const result = enrichQuery("cotton hoodie", classification, maleProfile);
    expect(result).toBe("cotton hoodie for men size L");
  });

  test("female profile with footwear query", () => {
    const classification = { category: "footwear", needsClothingSize: false, needsShoeSize: true, needsSex: true };
    const result = enrichQuery("summer sandals", classification, femaleProfile);
    expect(result).toBe("summer sandals for women size 8");
  });

  test("partial profile — sex only, no size", () => {
    const partialProfile = { sex: "female" };
    const classification = { category: "clothing", needsClothingSize: true, needsShoeSize: false, needsSex: true };
    const result = enrichQuery("yoga pants", classification, partialProfile);
    expect(result).toBe("yoga pants for women");
  });

  test("partial profile — size only, no sex", () => {
    const partialProfile = { clothesSize: "XL" };
    const classification = { category: "clothing", needsClothingSize: true, needsShoeSize: false, needsSex: true };
    const result = enrichQuery("cargo pants", classification, partialProfile);
    expect(result).toBe("cargo pants size XL");
  });
});
