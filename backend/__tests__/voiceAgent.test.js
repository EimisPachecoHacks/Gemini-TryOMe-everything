/**
 * Voice Agent (Giselle) Tests
 *
 * Tests for the voice agent's tool declarations, system prompt,
 * and client config generation.
 */

const giselleLive = require("../services/giselleLive");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Voice Agent — Tool Declarations", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(
    path.join(__dirname, "../services/giselleLive.js"),
    "utf-8"
  );

  test("declares exactly 8 tools", () => {
    const toolNames = [...source.matchAll(/name:\s*"(\w+)"/g)].map((m) => m[1]);
    expect(toolNames).toHaveLength(13);
  });

  test("includes all required tool names", () => {
    const expected = [
      "search_product",
      "add_to_cart",
      "try_on",
      "build_outfit",
      "show_favorites",
      "save_to_favorites",
      "save_video",
      "show_videos",
    ];
    for (const name of expected) {
      expect(source).toContain(`name: "${name}"`);
    }
  });

  test("build_outfit has all 6 category parameters", () => {
    const categories = ["top", "bottom", "shoes", "necklace", "earrings", "bracelet"];
    const buildOutfitIdx = source.indexOf('name: "build_outfit"');
    const nextToolIdx = source.indexOf('name: "show_favorites"');
    const block = source.substring(buildOutfitIdx, nextToolIdx);

    for (const cat of categories) {
      expect(block).toContain(`${cat}:`);
    }
  });

  test("try_on has optional itemNumber parameter", () => {
    const tryOnIdx = source.indexOf('name: "try_on"');
    const nextToolIdx = source.indexOf('name: "build_outfit"');
    const block = source.substring(tryOnIdx, nextToolIdx);
    expect(block).toContain("itemNumber");
    expect(block).toContain("NUMBER");
  });

  test("save_to_favorites, save_video, show_videos have no required params", () => {
    const noParamTools = ["save_to_favorites", "save_video", "show_videos"];
    for (const tool of noParamTools) {
      const idx = source.indexOf(`name: "${tool}"`);
      const block = source.substring(idx, idx + 300);
      expect(block).toContain("properties: {}");
    }
  });
});

describe("Voice Agent — System Prompt", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(
    path.join(__dirname, "../services/giselleLive.js"),
    "utf-8"
  );

  test("contains outfit builder instructions with 6 categories", () => {
    expect(source).toContain("OUTFIT BUILDER");
    expect(source).toContain("top, bottom, shoes, necklace, earrings, bracelet");
  });

  test("contains tool rules requiring explicit user request", () => {
    expect(source).toContain("NEVER ACT WITHOUT EXPLICIT USER REQUEST");
    expect(source).toContain("OUTFIT BUILDER — CONFIRMATION FLOW");
  });

  test("mentions key tool names in prompt or descriptions", () => {
    expect(source).toContain("save_to_favorites");
    expect(source).toContain("save_video");
    expect(source).toContain("show_videos");
    expect(source).toContain("show_favorites");
  });
});

describe("Voice Agent — buildSystemInstruction", () => {
  test("includes user context when provided", () => {
    const instruction = giselleLive.buildSystemInstruction({
      name: "Alice",
      size: "M",
      shoesSize: "8",
      sex: "female",
      preferences: "boho chic",
    });

    expect(instruction).toContain("Alice");
    expect(instruction).toContain("Clothing size: M");
    expect(instruction).toContain("Shoes size: 8");
    expect(instruction).toContain("Sex: female");
    expect(instruction).toContain("boho chic");
    expect(instruction).toContain("USER CONTEXT");
  });

  test("includes language instruction for non-English", () => {
    const instruction = giselleLive.buildSystemInstruction({
      name: "Carlos",
      language: "es",
    });

    expect(instruction).toContain("LANGUAGE");
    expect(instruction).toContain("Spanish");
    expect(instruction).toContain("Carlos");
  });

  test("works without user context", () => {
    const instruction = giselleLive.buildSystemInstruction({});

    expect(instruction).toContain("You are Giselle");
    expect(instruction).not.toContain("USER CONTEXT");
  });
});

describe("Voice Agent — getClientConfig", () => {
  test("returns required config fields", () => {
    const config = giselleLive.getClientConfig({ name: "Test" });

    expect(config).toHaveProperty("apiKey");
    expect(config).toHaveProperty("model");
    expect(config).toHaveProperty("systemInstruction");
    expect(config).toHaveProperty("tools");
    expect(config).toHaveProperty("voiceName");
    expect(config.model).toBe("gemini-2.5-flash-native-audio-preview-12-2025");
    expect(config.voiceName).toBe("Aoede");
  });

  test("tools match GISELLE_TOOLS export", () => {
    const config = giselleLive.getClientConfig({});
    expect(config.tools).toBe(giselleLive.GISELLE_TOOLS);
  });
});
