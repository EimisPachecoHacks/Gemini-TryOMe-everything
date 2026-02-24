#!/usr/bin/env node
/**
 * Local Smart Search Server (Playwright + Node.js)
 *
 * Runs on your local machine (residential IP) and serves Amazon search results
 * to the Cloud Run backend via HTTP.
 *
 * Usage:
 *   cd local-search
 *   npm install
 *   node smart-search-server.js
 *
 * Then expose with ngrok:
 *   ngrok http 5001
 *
 * Set the ngrok URL on Cloud Run:
 *   gcloud run services update geminitryonme-backend ... --set-env-vars "SMART_SEARCH_URL=https://xxxx.ngrok.io/search"
 */

const http = require("http");
const { chromium } = require("playwright");

const PORT = process.env.PORT || 5001;
const AMAZON_URL = "https://www.amazon.com";
const TARGET_PRODUCT_COUNT = 20;
const MAX_SCROLL_ROUNDS = 5;

function log(msg) {
  console.log(`[smart-search] ${msg}`);
}

/**
 * Extract products from the current Amazon search results page.
 * Passed as a function to page.evaluate() (not a string).
 */
function extractProducts() {
  let items = document.querySelectorAll('[data-component-type="s-search-result"]');
  if (items.length === 0) items = document.querySelectorAll('[data-asin]:not([data-asin=""])');

  const results = [];
  items.forEach(item => {
    try {
      const asin = item.getAttribute("data-asin");
      if (!asin) return;

      const isSponsored = item.querySelector(".puis-sponsored-label-text") !== null;

      let title = "";
      const h2List = item.querySelectorAll("h2");
      if (h2List.length >= 2) {
        title = h2List[1].textContent.trim();
      }
      if (!title) {
        const img = item.querySelector("img.s-image");
        if (img) {
          title = (img.getAttribute("alt") || "").replace(/^Sponsored Ad - /, "");
        }
      }
      if (!title) return;

      let brand = "";
      if (h2List.length >= 1) {
        brand = h2List[0].textContent.trim();
      }

      let product_url = "https://www.amazon.com/dp/" + asin;
      const titleLink = item.querySelector('a.s-line-clamp-2, a[class*="s-link-style"][class*="a-text-normal"]');
      if (titleLink) {
        const href = titleLink.getAttribute("href") || "";
        if (href && !href.includes("/sspa/click")) {
          product_url = href.startsWith("http") ? href : "https://www.amazon.com" + href;
        }
      }

      let price = "";
      const priceSpan = item.querySelector(".a-price .a-offscreen");
      if (priceSpan) price = priceSpan.textContent.trim();

      let rating = "";
      const ratingEl = item.querySelector('[aria-label*="out of 5"]');
      if (ratingEl) {
        const m = ratingEl.getAttribute("aria-label").match(/([\d.]+)/);
        if (m) rating = m[1];
      }

      let review_count = "";
      const fullText = item.textContent;
      const boughtMatch = fullText.match(/([\dK,]+\+?) bought in past month/);
      if (boughtMatch) review_count = boughtMatch[1] + " bought";

      const imgEl = item.querySelector("img.s-image");
      const image_url = imgEl ? (imgEl.getAttribute("src") || "") : "";
      if (!image_url) return;

      results.push({
        title: brand ? brand + " " + title : title,
        price, rating, review_count, image_url, product_url, is_sponsored: isSponsored
      });
    } catch (e) {}
  });
  return results;
}

async function smartSearch(query) {
  const allProducts = [];
  const seenTitles = new Set();

  log(`Starting search for: "${query}"`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(45000);

    // Stealth
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });
      window.chrome = { runtime: {} };
    });

    // Step 1: Navigate to search
    const searchUrl = `${AMAZON_URL}/s?k=${encodeURIComponent(query)}`;
    log(`Step 1: Navigating to ${searchUrl}`);
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

    try {
      await page.waitForSelector(
        '[data-component-type="s-search-result"], [data-asin]',
        { timeout: 15000 }
      );
      log("Step 1: Search results loaded");
    } catch {
      log("Warning: Search result selectors not found, checking page...");
      try {
        const pageTitle = await page.title();
        const pageUrl = page.url();
        log(`  Page title: ${pageTitle}`);
        log(`  Page URL: ${pageUrl}`);
        const bodyText = await page.evaluate(
          "document.body?.innerText?.substring(0, 500) || ''"
        );
        log(`  Page body (first 500 chars): ${bodyText}`);
        if (/captcha|robot|automated/i.test(bodyText)) {
          log(
            "  *** CAPTCHA/BOT DETECTION detected! Amazon is blocking this request. ***"
          );
        }
      } catch (debugErr) {
        log(`  Debug capture failed: ${debugErr.message}`);
      }

      // Retry
      log("  Retrying with page reload...");
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector(
          '[data-component-type="s-search-result"], [data-asin]',
          { timeout: 15000 }
        );
        log("  Retry successful!");
      } catch {
        log("  Retry failed. Amazon may be blocking from this IP.");
      }
    }

    // Step 2: Apply 4-star filter
    log("Step 2: Applying 4★+ customer review filter...");
    try {
      const starFilter = page.locator('[aria-label*="4 Stars & Up"]').first();
      if (await starFilter.isVisible({ timeout: 5000 })) {
        await starFilter.click();
        await page.waitForLoadState("domcontentloaded");
        await page.waitForSelector('[data-component-type="s-search-result"], [data-asin]', { timeout: 15000 });
      } else {
        log("Warning: 4-star filter not visible, trying alternative...");
        const altFilter = page
          .locator('section[aria-label="Customer Reviews"] a')
          .first();
        if (await altFilter.isVisible({ timeout: 3000 })) {
          await altFilter.click();
          await page.waitForLoadState("domcontentloaded");
          await page.waitForSelector('[data-component-type="s-search-result"], [data-asin]', { timeout: 15000 });
        } else {
          log("Warning: Star filter not found, proceeding without it.");
        }
      }
    } catch (e) {
      log(`Warning: Could not apply star filter: ${e.message}`);
    }

    // Step 3: Extract products
    log("Step 3: Extracting product listings...");
    for (let round = 0; round < MAX_SCROLL_ROUNDS; round++) {
      log(
        `  Extraction round ${round + 1}/${MAX_SCROLL_ROUNDS} (collected ${allProducts.length} so far)...`
      );

      try {
        const rawProducts = await page.evaluate(extractProducts);

        if (rawProducts && rawProducts.length > 0) {
          // Sort: organic first, then sponsored
          rawProducts.sort((a, b) => (a.is_sponsored ? 1 : 0) - (b.is_sponsored ? 1 : 0));
          for (const p of rawProducts) {
            delete p.is_sponsored;
            if (p.title && !seenTitles.has(p.title)) {
              seenTitles.add(p.title);
              allProducts.push(p);
            }
          }
          log(
            `  Extracted ${rawProducts.length} products (${allProducts.length} unique total)`
          );
        } else {
          log("  No products extracted in this round.");
          if (round === 0) {
            try {
              const domInfo = await page.evaluate(() => {
                const sr = document.querySelectorAll(
                  '[data-component-type="s-search-result"]'
                ).length;
                const ai = document.querySelectorAll(
                  '[data-asin]:not([data-asin=""])'
                ).length;
                const h2 = document.querySelectorAll("h2").length;
                const img = document.querySelectorAll("img.s-image").length;
                return `search-results: ${sr}, asin-items: ${ai}, h2s: ${h2}, s-images: ${img}`;
              });
              log(`  DOM state: ${domInfo}`);
            } catch {}
          }
        }
      } catch (e) {
        log(`  Error extracting products: ${e.message}`);
      }

      if (allProducts.length >= TARGET_PRODUCT_COUNT) {
        log(`Reached target of ${TARGET_PRODUCT_COUNT} products.`);
        break;
      }

      // Scroll for more
      if (round < MAX_SCROLL_ROUNDS - 1) {
        log("  Scrolling down for more products...");
        try {
          await page.evaluate("window.scrollBy(0, 1500)");
          await new Promise((r) => setTimeout(r, 1500));
        } catch (e) {
          log(`  Error scrolling: ${e.message}`);
          break;
        }
      }
    }
  } finally {
    await browser.close();
  }

  const finalProducts = allProducts.slice(0, TARGET_PRODUCT_COUNT);
  log(`Search complete. Returning ${finalProducts.length} products.`);
  return finalProducts;
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/search") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { query } = JSON.parse(body);
        if (!query || typeof query !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "query is required" }));
          return;
        }

        const products = await smartSearch(query.trim());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, products }));
      } catch (e) {
        log(`Error: ${e.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ success: false, error: e.message, products: [] })
        );
      }
    });
    return;
  }

  // Health check
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "smart-search-local" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  log(`Local smart search server running on http://localhost:${PORT}`);
  log(`POST /search { "query": "..." } to search`);
  log(`Expose with: ngrok http ${PORT}`);
});
