const express = require("express");
const router = express.Router();
const { classifyQuery } = require("../services/classifier");
const { optionalAuth } = require("../middleware/auth");

router.post("/", optionalAuth, async (req, res, next) => {
  try {
    const { query } = req.body;

    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ error: "query is required" });
    }

    console.log(`[classify-query] Classifying: "${query.trim()}"`);
    const result = await classifyQuery(query.trim());
    console.log(`[classify-query] Result: category=${result.category}, clothingSize=${result.needsClothingSize}, shoeSize=${result.needsShoeSize}, sex=${result.needsSex}`);

    res.json(result);
  } catch (error) {
    console.error(`[classify-query] Error:`, error.message);
    next(error);
  }
});

module.exports = router;
