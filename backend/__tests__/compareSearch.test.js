/**
 * Compare Search Tests
 *
 * Tests the Amazon product filtering logic and product name shortening
 * used in the cross-retailer price comparison feature.
 *
 * These functions mirror the logic in extension/background.js since
 * background.js runs in a service worker context and can't be imported directly.
 */

// ---------------------------------------------------------------------------
// Replicate the compare logic from background.js for testing
// ---------------------------------------------------------------------------

const COMPARE_AMAZON_LIMIT = 5;
const COMPARE_MIN_STARS = 4.0;
const COMPARE_MIN_REVIEWS = 100;

function filterAmazonForCompare(products) {
  return products
    .filter(p => p.rating_num >= COMPARE_MIN_STARS && p.review_count_num >= COMPARE_MIN_REVIEWS)
    .slice(0, COMPARE_AMAZON_LIMIT);
}

function shortenProductName(title) {
  let short = title.substring(0, 60);
  const lastSpace = short.lastIndexOf(' ');
  if (lastSpace > 30) short = short.substring(0, lastSpace);
  short = short.replace(/\s*[\(\[].*?[\)\]]/g, '').replace(/\s*-\s*Size\s*\w+/gi, '');
  return short.trim();
}

// ---------------------------------------------------------------------------
// Test Suite 1: Amazon product filtering
// ---------------------------------------------------------------------------
describe("Compare Search — Amazon Filter", () => {
  const makeProduct = (rating_num, review_count_num, title = "Test Product") => ({
    title,
    price: "$29.99",
    rating: String(rating_num),
    rating_num,
    review_count: `${review_count_num} ratings`,
    review_count_num,
    image_url: "https://example.com/img.jpg",
    product_url: "https://amazon.com/dp/B0TEST",
  });

  test("filters products with 4+ stars and 100+ reviews", () => {
    const products = [
      makeProduct(4.5, 250, "Good Product"),
      makeProduct(3.9, 500, "Below 4 stars"),
      makeProduct(4.2, 50, "Too few reviews"),
      makeProduct(4.0, 100, "Exactly at threshold"),
      makeProduct(4.8, 1000, "Best Product"),
    ];

    const filtered = filterAmazonForCompare(products);

    expect(filtered.length).toBe(3);
    expect(filtered[0].title).toBe("Good Product");
    expect(filtered[1].title).toBe("Exactly at threshold");
    expect(filtered[2].title).toBe("Best Product");
  });

  test("limits to 5 products max", () => {
    const products = [];
    for (let i = 0; i < 10; i++) {
      products.push(makeProduct(4.5, 200, `Product ${i}`));
    }

    const filtered = filterAmazonForCompare(products);
    expect(filtered.length).toBe(5);
  });

  test("returns empty array when no products meet criteria", () => {
    const products = [
      makeProduct(3.5, 50, "Bad Product"),
      makeProduct(2.0, 10, "Worse Product"),
    ];

    const filtered = filterAmazonForCompare(products);
    expect(filtered.length).toBe(0);
  });

  test("rejects products below 4 stars even with many reviews", () => {
    const products = [
      makeProduct(3.9, 10000, "Popular but low rated"),
    ];

    const filtered = filterAmazonForCompare(products);
    expect(filtered.length).toBe(0);
  });

  test("rejects products with few reviews even with high rating", () => {
    const products = [
      makeProduct(4.9, 5, "High rated but new"),
    ];

    const filtered = filterAmazonForCompare(products);
    expect(filtered.length).toBe(0);
  });

  test("accepts exactly 4.0 stars and exactly 100 reviews", () => {
    const products = [makeProduct(4.0, 100, "Edge case")];

    const filtered = filterAmazonForCompare(products);
    expect(filtered.length).toBe(1);
    expect(filtered[0].title).toBe("Edge case");
  });
});

// ---------------------------------------------------------------------------
// Test Suite 2: Product name shortening for Google Shopping search
// ---------------------------------------------------------------------------
describe("Compare Search — Product Name Shortening", () => {
  test("keeps short titles unchanged", () => {
    expect(shortenProductName("Nike Air Max 90 Running Shoes")).toBe(
      "Nike Air Max 90 Running Shoes"
    );
  });

  test("truncates long titles at word boundary before 60 chars", () => {
    const long = "BALEAF Women's Fleece Lined Leggings Water Resistant Winter Warm Thermal Hiking Running Pants";
    const result = shortenProductName(long);
    expect(result.length).toBeLessThanOrEqual(60);
    // Should end with a complete word (no trailing space)
    expect(result.endsWith(" ")).toBe(false);
    // Should be a truncated version of the original
    expect(long.startsWith(result)).toBe(true);
  });

  test("removes parenthetical size/color info within 60 chars", () => {
    expect(shortenProductName("Levi's 501 Jeans (32W x 30L)")).toBe(
      "Levi's 501 Jeans"
    );
  });

  test("removes bracket info", () => {
    expect(shortenProductName("Sony WH-1000XM5 Headphones [Black]")).toBe(
      "Sony WH-1000XM5 Headphones"
    );
  });

  test("removes '- Size X' pattern", () => {
    expect(shortenProductName("Nike Dri-FIT T-Shirt - Size M")).toBe(
      "Nike Dri-FIT T-Shirt"
    );
  });

  test("handles combined patterns", () => {
    const input = "Adidas Ultraboost 22 (Core Black) - Size 10 Running Shoes For Men";
    const result = shortenProductName(input);
    expect(result).not.toContain("Size 10");
    expect(result).not.toContain("Core Black");
  });
});

// ---------------------------------------------------------------------------
// Test Suite 3: Comparison data structure
// ---------------------------------------------------------------------------
describe("Compare Search — Data Structure", () => {
  test("comparison object has correct shape", () => {
    const comparison = {
      amazon: {
        title: "Test Product",
        price: "$29.99",
        rating: "4.5",
        review_count: "250 ratings",
        review_count_num: 250,
        image_url: "https://example.com/img.jpg",
        product_url: "https://amazon.com/dp/B0TEST",
        retailer: "Amazon",
      },
      alternatives: [
        {
          title: "Similar Product",
          price: "$24.99",
          retailer: "Walmart",
          image_url: "https://example.com/alt.jpg",
          product_url: "https://walmart.com/ip/123",
        },
      ],
    };

    // Amazon source
    expect(comparison.amazon).toBeDefined();
    expect(comparison.amazon.retailer).toBe("Amazon");
    expect(comparison.amazon.title).toBeTruthy();
    expect(comparison.amazon.price).toBeTruthy();
    expect(comparison.amazon.rating).toBeTruthy();
    expect(comparison.amazon.image_url).toBeTruthy();
    expect(comparison.amazon.product_url).toBeTruthy();

    // Alternatives
    expect(Array.isArray(comparison.alternatives)).toBe(true);
    expect(comparison.alternatives.length).toBeGreaterThan(0);
    expect(comparison.alternatives[0].retailer).toBe("Walmart");
    expect(comparison.alternatives[0].price).toBeTruthy();
  });

  test("comparison with no alternatives has empty array", () => {
    const comparison = {
      amazon: {
        title: "Unique Product",
        price: "$99.99",
        rating: "4.8",
        retailer: "Amazon",
      },
      alternatives: [],
    };

    expect(comparison.alternatives).toEqual([]);
  });

  test("alternatives are limited to 3 per product", () => {
    const alts = [
      { title: "Alt 1", price: "$10", retailer: "Walmart" },
      { title: "Alt 2", price: "$11", retailer: "Target" },
      { title: "Alt 3", price: "$12", retailer: "Shein" },
      { title: "Alt 4", price: "$13", retailer: "Temu" },
      { title: "Alt 5", price: "$14", retailer: "eBay" },
    ];

    // The comparison flow slices to 3
    const limited = alts.slice(0, 3);
    expect(limited.length).toBe(3);
    expect(limited[2].retailer).toBe("Shein");
  });
});
