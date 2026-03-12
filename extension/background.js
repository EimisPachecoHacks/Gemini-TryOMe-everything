/**
 * GeminiTryOnMe - Background Service Worker
 *
 * Routes messages between content scripts, popup, and the backend API.
 * Handles auth token injection for all API calls.
 */

const DEFAULT_BACKEND_URL = "https://geminitryonme-backend-81189935460.us-central1.run.app";

async function getBackendUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["backendUrl"], (result) => {
      resolve(result.backendUrl || DEFAULT_BACKEND_URL);
    });
  });
}

/**
 * Get stored auth tokens if available.
 */
async function getAuthTokens() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["authTokens"], (result) => {
      resolve(result.authTokens || null);
    });
  });
}

/**
 * Ensure the auth token is fresh. If it expires within 5 minutes, refresh proactively.
 */
async function ensureFreshToken() {
  const tokens = await getAuthTokens();
  if (!tokens || !tokens.idToken) return;

  // Refresh if token expires within 5 minutes (or expiresAt is missing)
  const bufferMs = 5 * 60 * 1000;
  if (tokens.expiresAt && Date.now() < tokens.expiresAt - bufferMs) return;

  console.log("[bg] Token expiring soon — proactively refreshing");
  await tryRefreshToken();
}

/**
 * Build headers including auth token if available.
 */
async function buildHeaders() {
  await ensureFreshToken();
  const headers = { "Content-Type": "application/json" };
  const tokens = await getAuthTokens();
  if (tokens && tokens.idToken) {
    headers["Authorization"] = `Bearer ${tokens.idToken}`;
  }
  return headers;
}

/**
 * Try to refresh the auth token if we get a 401.
 */
async function tryRefreshToken() {
  const tokens = await getAuthTokens();
  if (!tokens || !tokens.refreshToken) return false;

  try {
    const backendUrl = await getBackendUrl();
    const resp = await fetch(`${backendUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    if (!resp.ok) return false;
    const newTokens = await resp.json();
    await chrome.storage.local.set({
      authTokens: {
        ...tokens,
        idToken: newTokens.idToken,
        accessToken: newTokens.accessToken,
        expiresAt: Date.now() + (newTokens.expiresIn * 1000),
      },
    });
    return true;
  } catch (err) {
    console.warn("[bg] Token refresh failed:", err.message);
    return false;
  }
}

/**
 * Forward an API request to the backend with auth headers and 401 retry.
 */
async function apiFetch(method, endpoint, data, retry = true) {
  const backendUrl = await getBackendUrl();
  const url = `${backendUrl}${endpoint}`;
  const headers = await buildHeaders();

  const controller = new AbortController();
  const timeoutMs = 300000; // 5 minutes — Cloud Run has 600s, give client 5min
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const opts = { method, headers, signal: controller.signal };
  if (data !== undefined) {
    opts.body = JSON.stringify(data);
  }

  console.log(`[bg] fetch: ${method} ${url}`);
  let response;
  try {
    response = await fetch(url, opts);
  } catch (networkErr) {
    clearTimeout(timeoutId);
    const reason = networkErr.name === "AbortError"
      ? `Request timed out after ${timeoutMs / 1000}s`
      : networkErr.message;
    console.error(`[bg] Network error: ${method} ${endpoint} — ${reason}`);
    throw new Error(`Network error on ${method} ${endpoint}: ${reason}`);
  }
  clearTimeout(timeoutId);
  console.log(`[bg] fetch response: ${method} ${endpoint} → ${response.status}`);

  if (response.status === 401 && retry) {
    console.log(`[bg] 401 received, attempting token refresh...`);
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      console.log(`[bg] Token refreshed, retrying ${method} ${endpoint}`);
      return apiFetch(method, endpoint, data, false);
    }
    console.warn(`[bg] Token refresh failed, returning 401 error`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[bg] API error: ${method} ${endpoint} → ${response.status}: ${errorText}`);
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

function apiPost(endpoint, data) { return apiFetch("POST", endpoint, data); }
function apiGet(endpoint) { return apiFetch("GET", endpoint); }
function apiDelete(endpoint) { return apiFetch("DELETE", endpoint); }
function apiPut(endpoint, data) { return apiFetch("PUT", endpoint, data); }

// Allowed image CDN domains for proxy fetch (prevents open-proxy abuse)
const ALLOWED_IMAGE_HOSTS = [
  "m.media-amazon.com", "images-na.ssl-images-amazon.com", "images-eu.ssl-images-amazon.com",
  "img.ltwebstatic.com", "img.kwcdn.com",
  "ae01.alicdn.com", "i.imgur.com",
  "encrypted-tbn0.gstatic.com", "encrypted-tbn1.gstatic.com", "encrypted-tbn2.gstatic.com", "encrypted-tbn3.gstatic.com",
  "lh3.googleusercontent.com", "shopping.googleusercontent.com",
];

async function proxyImageFetch(imageUrl) {
  // Validate URL against allowed CDN domains
  try {
    const parsed = new URL(imageUrl);
    if (!ALLOWED_IMAGE_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith("." + h))) {
      throw new Error(`Image proxy blocked: ${parsed.hostname} is not an allowed CDN`);
    }
  } catch (e) {
    if (e.message.includes("proxy blocked")) throw e;
    throw new Error("Invalid image URL for proxy");
  }

  const response = await fetch(imageUrl);
  const blob = await response.blob();

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function getStoredPhotos() {
  const result = await chrome.storage.local.get(["bodyPhoto", "selectedPoseIndex", "selectedFaceIndex"]);
  let bodyPhoto = result.bodyPhoto || null;
  let facePhoto = null;
  const selectedPoseIndex = result.selectedPoseIndex ?? 0;
  const selectedFaceIndex = result.selectedFaceIndex ?? 0;

  // Always fetch face photo fresh based on selectedFaceIndex (indices 3+ in originals)
  try {
    const allPhotos = await apiGet("/api/profile/photos/all");
    if (!bodyPhoto && allPhotos.generated && allPhotos.generated[selectedPoseIndex]) {
      bodyPhoto = allPhotos.generated[selectedPoseIndex];
      await chrome.storage.local.set({ bodyPhoto });
    }
    if (allPhotos.originals) {
      const facePhotos = allPhotos.originals.slice(3);
      const idx = Math.min(selectedFaceIndex, facePhotos.length - 1);
      facePhoto = facePhotos[idx] || allPhotos.originals[allPhotos.originals.length - 1] || null;
      console.log(`[background] getStoredPhotos: selectedFaceIndex=${selectedFaceIndex}, facePhotos.length=${facePhotos.length}, using idx=${idx}, facePhoto=${facePhoto ? facePhoto.substring(0, 20) + '...' : 'null'}`);
    }
  } catch (err) {
    console.warn("[background] Failed to fetch photos from backend:", err.message);
  }

  return { bodyPhoto, facePhoto, selectedPoseIndex };
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "GET_USER_PHOTOS": {
          const photos = await getStoredPhotos();
          sendResponse({ data: photos });
          break;
        }

        case "GET_AUTH_STATUS": {
          const tokens = await getAuthTokens();
          const isAuthenticated = !!(tokens && tokens.idToken);
          sendResponse({ data: { isAuthenticated } });
          break;
        }

        case "ANALYZE_PRODUCT": {
          const result = await apiPost("/api/analyze", {
            productImage: message.imageBase64,
            title: message.title,
            breadcrumbs: message.breadcrumbs,
          });
          sendResponse({ data: result });
          break;
        }

        case "TRY_ON": {
          console.log(`[background] TRY_ON — framing: "${message.framing}", poseIndex: ${message.poseIndex}, garmentClass: "${message.garmentClass}", title: "${message.productTitle || ""}"`);
          const result = await apiPost("/api/try-on", {
            sourceImage: message.bodyImageBase64,
            referenceImage: message.garmentImageBase64,
            garmentClass: message.garmentClass,
            mergeStyle: message.mergeStyle || "SEAMLESS",
            framing: message.framing || "full",
            poseIndex: message.poseIndex ?? 0,
            quickMode: message.quickMode || false,
            productTitle: message.productTitle || "",
          });
          sendResponse({ data: result });
          break;
        }

        case "TRY_ON_OUTFIT": {
          const result = await apiPost("/api/try-on/outfit", {
            sourceImage: message.bodyImageBase64 || null,
            garments: message.garments,
            framing: message.framing || "full",
            poseIndex: message.poseIndex ?? 0,
          });
          sendResponse({ data: result });
          break;
        }

        case "TRY_ON_COSMETICS": {
          const result = await apiPost("/api/cosmetics", {
            faceImage: message.faceImageBase64,
            cosmeticType: message.cosmeticType,
            color: message.color,
            productImage: message.productImage || null,
          });
          sendResponse({ data: result });
          break;
        }

        case "TRY_ON_ACCESSORY": {
          const result = await apiPost("/api/accessories", {
            faceImage: message.faceImageBase64,
            productImage: message.productImageBase64,
            accessoryType: message.accessoryType,
          });
          sendResponse({ data: result });
          break;
        }

        case "GENERATE_VIDEO": {
          const result = await apiPost("/api/video", {
            image: message.imageBase64,
            prompt: message.prompt,
          });
          sendResponse({ data: result });
          break;
        }

        case "GET_VIDEO_STATUS": {
          const provider = message.provider || "veo";
          const result = await apiGet(`/api/video/${message.jobId}?provider=${provider}`);
          sendResponse({ data: result });
          break;
        }

        case "REMOVE_BG": {
          const result = await apiPost("/api/image/remove-bg", {
            image: message.imageBase64,
          });
          sendResponse({ data: result });
          break;
        }

        case "SET_BACKEND_URL": {
          const newUrl = message.url;
          await chrome.storage.local.set({ backendUrl: newUrl });
          sendResponse({ data: { backendUrl: newUrl } });
          break;
        }

        case "VOICE_CHAT": {
          const result = await apiPost("/api/voice", {
            message: message.text,
            history: message.history || [],
            userContext: message.userContext || {},
          });
          sendResponse({ data: result });
          break;
        }

        case "SMART_SEARCH": {
          // Client-side search: open Amazon in a hidden tab, extract products using user's residential IP
          try {
            const products = await clientSideAmazonSearch(message.query);
            if (products && products.length > 0) {
              console.log(`[background] Client-side search returned ${products.length} products`);
              sendResponse({ data: { success: true, products } });
            } else {
              // Fallback to backend if client-side returns nothing
              console.log("[background] Client-side search returned 0 products, falling back to backend");
              const result = await apiPost("/api/smart-search", {
                query: message.query,
              });
              sendResponse({ data: result });
            }
          } catch (err) {
            console.warn("[background] Client-side search failed, falling back to backend:", err.message);
            const result = await apiPost("/api/smart-search", {
              query: message.query,
            });
            sendResponse({ data: result });
          }
          break;
        }

        case "COMPARE_SEARCH": {
          try {
            const compareResult = await compareAcrossRetailers(message.query);
            sendResponse({ data: { success: true, comparisons: compareResult } });
          } catch (err) {
            console.error("[background] Compare search failed:", err.message);
            sendResponse({ data: { error: "Compare search failed: " + err.message } });
          }
          break;
        }

        case "SHARE_EMAIL": {
          const result = await apiPost("/api/share/email", {
            recipientEmail: message.recipientEmail,
            message: message.message || "",
            resultImage: message.resultImage,
            productTitle: message.productTitle || "",
          });
          sendResponse({ data: result });
          break;
        }

        case "PROXY_IMAGE": {
          const base64 = await proxyImageFetch(message.url);
          sendResponse({ data: base64 });
          break;
        }

        case "API_CALL": {
          const method = (message.method || "").toUpperCase();
          const endpoint = message.endpoint;
          console.log(`[bg] API_CALL: ${method} ${endpoint}`);

          // Whitelist allowed API endpoints to prevent abuse from compromised content scripts
          const ALLOWED_PREFIXES = [
            "/api/auth", "/api/profile", "/api/favorites", "/api/try-on", "/api/cosmetics",
            "/api/accessories", "/api/video", "/api/analyze", "/api/image",
            "/api/smart-search", "/api/voice", "/api/cart", "/api/share",
          ];
          if (!ALLOWED_PREFIXES.some(p => endpoint.startsWith(p))) {
            console.warn(`[bg] Blocked endpoint: ${endpoint}`);
            sendResponse({ error: `Endpoint not allowed: ${endpoint}` });
            break;
          }

          let result;
          const startTime = Date.now();

          if (method === "PUT") {
            result = await apiPut(endpoint, message.data || {});
          } else if (method === "DELETE") {
            result = await apiDelete(endpoint);
          } else if (method === "GET" || !message.data || Object.keys(message.data).length === 0) {
            result = await apiGet(endpoint);
          } else {
            result = await apiPost(endpoint, message.data);
          }
          console.log(`[bg] API_CALL done: ${method} ${endpoint} (${Date.now() - startTime}ms)`);
          sendResponse({ data: result });
          break;
        }

        case "GET_PHOTOS": {
          const photos = await getStoredPhotos();
          sendResponse({ data: photos });
          break;
        }

        case "ADD_TO_CART": {
          const result = await apiPost("/api/cart/add", {
            productUrl: message.productUrl,
            quantity: message.quantity || 1,
          });
          sendResponse({ data: result });
          break;
        }

        case "SAVE_TO_FAVORITES":
        case "ANIMATE_TRYON":
        case "SAVE_VIDEO": {
          // Route to the tab that did the most recent try-on (outfit builder or smart search)
          const voiceAllTabs = await chrome.tabs.query({});
          let targetTab = null;

          if (message.source === "outfit") {
            // Route to wardrobe tab
            targetTab = voiceAllTabs
              .filter(t => t.url && t.url.includes("outfit-builder/wardrobe.html"))
              .sort((a, b) => b.id - a.id)[0];
          }

          if (!targetTab) {
            // Route to smart search tab (default / fallback)
            targetTab = voiceAllTabs
              .filter(t => t.url && t.url.includes("smart-search/results.html"))
              .sort((a, b) => b.id - a.id)[0];
          }

          if (!targetTab) {
            // Final fallback: active tab
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            targetTab = activeTab;
          }

          if (targetTab?.id) {
            console.log(`[background] ${message.type} → tab ${targetTab.id} (source: ${message.source || 'unset'})`);
            chrome.tabs.sendMessage(targetTab.id, { type: message.type }, (res) => {
              if (chrome.runtime.lastError) {
                console.warn(`[background] ${message.type} failed:`, chrome.runtime.lastError.message);
                sendResponse({ data: { success: false, error: "Content script not ready" } });
              } else {
                sendResponse({ data: res || { success: true } });
              }
            });
          } else {
            sendResponse({ error: "No tab found" });
          }
          break;
        }

        case "OPEN_POPUP": {
          // Open the side panel instead of popup
          if (_sender.tab) {
            await chrome.sidePanel.open({ tabId: _sender.tab.id });
          }
          sendResponse({ data: { opened: true } });
          break;
        }

        case "CAPTURE_TAB_SCREENSHOT": {
          // Capture a screenshot of the currently visible tab (used for voice agent vision)
          try {
            const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            if (tab) {
              console.log("[background] 📸 Capturing screenshot of tab:", tab.id, tab.url?.substring(0, 80));
              const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 });
              console.log("[background] ✅ Screenshot captured:", dataUrl ? `${(dataUrl.length / 1024).toFixed(0)}KB` : "null");
              sendResponse({ data: dataUrl });
            } else {
              console.warn("[background] ⚠️ No active tab found for screenshot");
              sendResponse({ data: null });
            }
          } catch (err) {
            console.error("[background] ❌ Screenshot capture FAILED:", err.message);
            sendResponse({ data: null });
          }
          break;
        }

        case "VOICE_SELECT_SEARCH_ITEM": {
          // Route to the smart search results tab
          console.log("[background] 🎯 VOICE_SELECT_SEARCH_ITEM — item #" + message.number);
          const allTabs = await chrome.tabs.query({});
          const searchTab = allTabs
            .filter(t => t.url && t.url.includes("smart-search/results.html"))
            .sort((a, b) => b.id - a.id)[0];
          if (searchTab) {
            console.log("[background] ✅ Found search results tab:", searchTab.id, searchTab.url?.substring(0, 80));
            try {
              chrome.tabs.sendMessage(searchTab.id, {
                type: "VOICE_SELECT_SEARCH_ITEM",
                number: message.number,
              }, (resp) => {
                if (chrome.runtime.lastError) {
                  console.warn("[background] ⚠️ Content script not ready:", chrome.runtime.lastError.message);
                  sendResponse({ data: { status: "not_found" } });
                } else {
                  sendResponse({ data: resp || { status: "not_found" } });
                }
              });
            } catch (e) {
              console.warn("[background] ⚠️ Failed to send to search tab:", e.message);
              sendResponse({ data: { status: "not_found" } });
            }
          } else {
            console.warn("[background] ⚠️ No smart-search/results.html tab found among", allTabs.length, "tabs");
            sendResponse({ data: { status: "no_tab" } });
          }
          break;
        }

        case "VOICE_TRY_ON_OUTFIT": {
          // Route to the outfit builder wardrobe tab to trigger try-on
          console.log("[background] 🎯 VOICE_TRY_ON_OUTFIT");
          const tryOnTabs = await chrome.tabs.query({});
          const tryOnTab = tryOnTabs
            .filter(t => t.url && t.url.includes("outfit-builder/wardrobe.html"))
            .sort((a, b) => b.id - a.id)[0];
          if (tryOnTab) {
            chrome.tabs.sendMessage(tryOnTab.id, { type: "VOICE_TRY_ON_OUTFIT" }, (res) => {
              sendResponse({ data: res || { status: "ok" } });
            });
          } else {
            sendResponse({ data: { status: "no_tab", error: "No outfit builder tab found" } });
          }
          break;
        }

        case "VOICE_SELECT_OUTFIT_ITEMS": {
          // Route to the outfit builder wardrobe tab
          console.log("[background] 🎯 VOICE_SELECT_OUTFIT_ITEMS — " + message.category + " #" + message.number);
          const allTabs2 = await chrome.tabs.query({});
          const outfitTab = allTabs2
            .filter(t => t.url && t.url.includes("outfit-builder/wardrobe.html"))
            .sort((a, b) => b.id - a.id)[0];
          if (outfitTab) {
            console.log("[background] ✅ Found wardrobe tab:", outfitTab.id);
            chrome.tabs.sendMessage(outfitTab.id, {
              type: "VOICE_SELECT_OUTFIT_ITEMS",
              category: message.category,
              number: message.number,
            });
            sendResponse({ data: { status: "ok" } });
          } else {
            console.warn("[background] ⚠️ No outfit-builder/wardrobe.html tab found among", allTabs2.length, "tabs");
            sendResponse({ data: { status: "no_tab" } });
          }
          break;
        }

        case "OPEN_URL": {
          // Open a URL in a new tab — used by content scripts that can't window.open due to CSP
          if (message.url) {
            chrome.tabs.create({ url: message.url });
          }
          sendResponse({ data: { opened: true } });
          break;
        }

        default:
          sendResponse({ error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      const msgType = message.type || "UNKNOWN";
      console.error(`[GeminiTryOnMe background] Error handling ${msgType}:`, err.message, err);
      sendResponse({ error: `${err.message}` });
    }
  })();

  return true;
});

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// Also handle OPEN_POPUP messages from content script (now opens side panel)
// This is handled inside the message listener but we also set side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---------------------------------------------------------------------------
// Context Menu — "Try On with Gemini TryOnMe" on right-click any image
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "gemini-tryon-image",
    title: "Try On with Gemini TryOnMe",
    contexts: ["image"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "gemini-tryon-image") return;
  const imageUrl = info.srcUrl;
  if (!imageUrl) return;

  console.log("[bg] Context menu try-on for image:", imageUrl?.substring(0, 80));

  // Check if content script is already injected
  let alreadyInjected = false;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !!window.__novaTryOnMeLoaded,
    });
    alreadyInjected = result?.result === true;
  } catch (_) {}

  if (!alreadyInjected) {
    // Inject content scripts dynamically on unsupported sites
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["styles/content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["utils/scraper-registry.js"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["utils/image-utils.js"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["utils/api-client.js"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch (err) {
      console.warn("[bg] Failed to inject content scripts:", err.message);
    }
  }

  // Send the image URL to content script
  const delay = alreadyInjected ? 100 : 500;
  setTimeout(() => {
    chrome.tabs.sendMessage(tab.id, {
      type: "CONTEXT_MENU_TRYON",
      imageUrl,
      pageUrl: info.pageUrl,
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[bg] Context menu message:", chrome.runtime.lastError.message);
      }
    });
  }, delay);
});

// ---------------------------------------------------------------------------
// Client-side Amazon Smart Search
// Opens Amazon in a hidden tab, extracts products using user's residential IP.
// No backend needed, no CAPTCHA issues.
// ---------------------------------------------------------------------------
const AMAZON_SEARCH_URL = "https://www.amazon.com/s";
const AMAZON_4STAR_REFINEMENT = "p_72:2661618011"; // 4-star & up filter
const TARGET_PRODUCTS = 20;

async function clientSideAmazonSearch(query) {
  console.log(`[smart-search] Client-side search for: "${query}"`);

  // Build Amazon search URL with 4-star filter baked in
  const url = `${AMAZON_SEARCH_URL}?k=${encodeURIComponent(query)}&rh=${encodeURIComponent(AMAZON_4STAR_REFINEMENT)}`;

  // Create a hidden background tab
  const tab = await chrome.tabs.create({ url, active: false });

  try {
    // Wait for the tab to finish loading
    await waitForTabLoad(tab.id);

    // Small delay for dynamic content to render
    await sleep(2000);

    // Extract products by injecting script into the Amazon tab
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractAmazonProducts,
    });

    const products = results?.[0]?.result || [];
    console.log(`[smart-search] Extracted ${products.length} products from Amazon tab`);

    // Deduplicate and limit
    const seen = new Set();
    const unique = [];
    for (const p of products) {
      if (p.title && !seen.has(p.title)) {
        seen.add(p.title);
        unique.push(p);
      }
      if (unique.length >= TARGET_PRODUCTS) break;
    }

    return unique;
  } finally {
    // Always close the hidden tab
    try {
      await chrome.tabs.remove(tab.id);
    } catch (e) {
      // Tab may have been closed already
    }
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Tab load timed out"));
    }, 30000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Injected into the Amazon search results page to extract product data.
 * Runs in the page context (not the extension context).
 */
function extractAmazonProducts() {
  let items = document.querySelectorAll('[data-component-type="s-search-result"]');
  if (items.length === 0) items = document.querySelectorAll('[data-asin]:not([data-asin=""])');

  const results = [];
  items.forEach((item) => {
    try {
      const asin = item.getAttribute("data-asin");
      if (!asin) return;

      const isSponsored = item.querySelector(".puis-sponsored-label-text") !== null;

      // Title from second h2 (first h2 is brand name)
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

      // Brand from first h2
      let brand = "";
      if (h2List.length >= 1) {
        brand = h2List[0].textContent.trim();
      }

      // Product URL
      let product_url = "https://www.amazon.com/dp/" + asin;
      const titleLink = item.querySelector('a.s-line-clamp-2, a[class*="s-link-style"][class*="a-text-normal"]');
      if (titleLink) {
        const href = titleLink.getAttribute("href") || "";
        if (href && !href.includes("/sspa/click")) {
          product_url = href.startsWith("http") ? href : "https://www.amazon.com" + href;
        }
      }

      // Price
      let price = "";
      const priceSpan = item.querySelector(".a-price .a-offscreen");
      if (priceSpan) price = priceSpan.textContent.trim();

      // Rating
      let rating = "";
      const ratingEl = item.querySelector('[aria-label*="out of 5"]');
      if (ratingEl) {
        const m = ratingEl.getAttribute("aria-label").match(/([\d.]+)/);
        if (m) rating = m[1];
      }

      // Review count (numeric)
      let review_count = "";
      let review_count_num = 0;
      const reviewCountEl = item.querySelector('[aria-label*="ratings"], [aria-label*="reviews"]') ||
                            item.querySelector('a span.a-size-base');
      if (reviewCountEl) {
        const rcText = reviewCountEl.textContent.trim().replace(/,/g, '');
        const rcMatch = rcText.match(/^([\d]+)/);
        if (rcMatch) review_count_num = parseInt(rcMatch[1], 10);
      }
      // Fallback: look for "X ratings" in aria-label
      if (review_count_num === 0) {
        const ratingLink = item.querySelector('a[href*="#customerReviews"]');
        if (ratingLink) {
          const ariaLabel = ratingLink.getAttribute('aria-label') || '';
          const countMatch = ariaLabel.match(/([\d,]+)\s*(?:ratings|reviews)/i);
          if (countMatch) review_count_num = parseInt(countMatch[1].replace(/,/g, ''), 10);
          if (review_count_num === 0) {
            const spanText = ratingLink.textContent.trim().replace(/,/g, '');
            const spanMatch = spanText.match(/^(\d+)/);
            if (spanMatch) review_count_num = parseInt(spanMatch[1], 10);
          }
        }
      }

      // Popularity
      const fullText = item.textContent;
      const boughtMatch = fullText.match(/([\dK,]+\+?) bought in past month/);
      if (boughtMatch) review_count = boughtMatch[1] + " bought";

      // Image
      const imgEl = item.querySelector("img.s-image");
      const image_url = imgEl ? (imgEl.getAttribute("src") || "") : "";
      if (!image_url) return;

      results.push({
        title: brand ? brand + " " + title : title,
        price,
        rating,
        rating_num: parseFloat(rating) || 0,
        review_count,
        review_count_num,
        image_url,
        product_url,
        _sponsored: isSponsored,
      });
    } catch (e) {}
  });

  // Sort: organic first, then sponsored
  results.sort((a, b) => (a._sponsored ? 1 : 0) - (b._sponsored ? 1 : 0));
  results.forEach((p) => delete p._sponsored);

  return results;
}

// ---------------------------------------------------------------------------
// Price Compare: Amazon is ALWAYS the reference
// 1. Search Amazon → filter 4+ stars, 100+ reviews → up to 5 products
// 2. Extract: title, image, price, rating, reviews, link from each
// 3. For each product → search ALL retailers simultaneously
// 4. Retailers: Walmart, Shein, Temu, Poshmark (via Google Shopping site: filter)
// ---------------------------------------------------------------------------

const COMPARE_AMAZON_LIMIT = 5;
const COMPARE_MIN_STARS = 4.0;
const COMPARE_MIN_REVIEWS = 100;

const COMPARE_RETAILERS = [
  { name: "Walmart", siteFilter: "site:walmart.com" },
  { name: "SHEIN", siteFilter: "site:shein.com" },
  { name: "Temu", siteFilter: "site:temu.com" },
  { name: "Poshmark", siteFilter: "site:poshmark.com" },
];

/**
 * Filter Amazon products by quality criteria.
 */
function filterAmazonForCompare(products) {
  return products
    .filter(p => p.rating_num >= COMPARE_MIN_STARS && p.review_count_num >= COMPARE_MIN_REVIEWS)
    .slice(0, COMPARE_AMAZON_LIMIT);
}

async function compareAcrossRetailers(query) {
  console.log(`[compare] Starting cross-retailer comparison for: "${query}"`);
  const startTime = Date.now();

  // Step 1: Search Amazon — always the reference
  const allAmazon = await clientSideAmazonSearch(query);
  console.log(`[compare] Amazon returned ${allAmazon.length} products in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  let topAmazon = filterAmazonForCompare(allAmazon);
  console.log(`[compare] After filtering (${COMPARE_MIN_STARS}+ stars, ${COMPARE_MIN_REVIEWS}+ reviews): ${topAmazon.length} products`);

  if (topAmazon.length === 0) {
    // Fallback: take top 5 by rating if nothing passes the strict filter
    topAmazon = allAmazon
      .filter(p => p.rating_num >= 3.5)
      .sort((a, b) => b.rating_num - a.rating_num || b.review_count_num - a.review_count_num)
      .slice(0, COMPARE_AMAZON_LIMIT);
    if (topAmazon.length === 0) return [];
    console.log(`[compare] Fallback: using ${topAmazon.length} products with relaxed filter`);
  }

  // Step 2: For each Amazon product, do ONE Google Shopping search (no site: filter)
  // and extract retailer names from the results. This finds more alternatives than
  // separate site:-filtered searches because Google returns cross-retailer results.
  const comparisons = await Promise.all(
    topAmazon.map(async (amazonProduct, idx) => {
      const productTitle = amazonProduct.title;
      console.log(`[compare] [${idx + 1}/${topAmazon.length}] Searching Google Shopping for: "${productTitle.substring(0, 60)}..."`);

      // Single search with full product title — no site: filter
      const alternatives = await searchGoogleShoppingAll(productTitle);
      console.log(`[compare] [${idx + 1}] Found ${alternatives.length} alternatives across retailers`);

      return {
        amazon: {
          title: amazonProduct.title,
          price: amazonProduct.price,
          rating: amazonProduct.rating,
          review_count: amazonProduct.review_count,
          review_count_num: amazonProduct.review_count_num,
          image_url: amazonProduct.image_url,
          product_url: amazonProduct.product_url,
          retailer: "Amazon",
        },
        alternatives,
      };
    })
  );

  console.log(`[compare] Complete! Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  return comparisons;
}

/**
 * Search Google Shopping for a product (no site: filter) and return all
 * non-Amazon alternatives with retailer names extracted from the results.
 * Uses ONE tab instead of 4 separate site:-filtered searches.
 */
async function searchGoogleShoppingAll(productTitle) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(productTitle)}&tbm=shop`;
  console.log(`[compare] Opening Google Shopping: ${url.substring(0, 100)}...`);
  const tab = await chrome.tabs.create({ url, active: false });

  try {
    await waitForTabLoad(tab.id);
    await sleep(3000); // Extra time for JS-rendered content

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractGoogleShoppingResults,
    });

    const products = results?.[0]?.result || [];
    console.log(`[compare] Google Shopping returned ${products.length} total products:`, products.map(p => `${(p.retailer || 'unknown')}:"${(p.title || '').substring(0, 30)}" ${p.price}`).join(', '));

    // Filter out Amazon results and deduplicate by title
    const seen = new Set();
    const alternatives = products.filter(p => {
      const retailer = (p.retailer || '').toLowerCase();
      if (!retailer || retailer.includes('amazon')) return false;
      const key = (p.title || '').toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    console.log(`[compare] After filtering Amazon + dedup: ${alternatives.length} alternatives`);
    return alternatives;
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
  }
}

/**
 * Shorten a product title for search.
 * Used as utility — not in main compare flow (full title is used).
 */
function shortenProductName(title) {
  let short = title.substring(0, 60);
  const lastSpace = short.lastIndexOf(' ');
  if (lastSpace > 30) short = short.substring(0, lastSpace);
  short = short.replace(/\s*[\(\[].*?[\)\]]/g, '').replace(/\s*-\s*Size\s*\w+/gi, '');
  return short.trim();
}

/**
 * Injected into Google Shopping results page to extract product matches.
 * Extracts title, price, image, product URL, and retailer/store name.
 */
function extractGoogleShoppingResults() {
  const results = [];
  const debug = [];

  debug.push(`Page title: ${document.title}`);
  debug.push(`URL: ${location.href}`);

  // Dump page structure for debugging — find all elements with $ price text
  const priceEls = [];
  document.querySelectorAll('*').forEach(el => {
    if (el.children.length === 0 && /^\$\d/.test(el.textContent.trim())) {
      priceEls.push(el);
    }
  });
  debug.push(`Elements with $ price: ${priceEls.length}`);

  // For each price element, walk up to find the product card container
  const processedContainers = new Set();
  for (const priceEl of priceEls) {
    // Walk up to find a reasonable card container (stop at ~8 levels or a known container)
    let container = priceEl;
    for (let i = 0; i < 8; i++) {
      if (!container.parentElement || container.parentElement === document.body) break;
      container = container.parentElement;
      // Stop if container is large enough to be a card (has both text and image)
      if (container.querySelector('img') && container.textContent.length > 20 && container.textContent.length < 3000) break;
    }
    if (processedContainers.has(container)) continue;
    processedContainers.add(container);

    try {
      const cardText = container.textContent || '';

      // Price
      const priceMatch = cardText.match(/\$[\d,.]+/);
      const price = priceMatch ? priceMatch[0] : '';
      if (!price) continue;

      // Title: find the longest leaf text node that isn't a price
      let title = '';
      container.querySelectorAll('*').forEach(el => {
        if (el.children.length === 0) {
          const t = el.textContent.trim();
          if (t.length > title.length && t.length > 5 && t.length < 200 && !/^\$/.test(t) && !/^[\d.]+$/.test(t)) {
            title = t;
          }
        }
      });
      if (!title || title.length < 5) continue;

      // Image
      const img = container.querySelector('img:not([src*="google"]):not([src*="gstatic"]):not([width="1"])');
      const image_url = img ? (img.src || img.getAttribute('data-src') || '') : '';

      // Product URL — try all anchors in the container to find a real destination URL
      let product_url = '';
      const allContainerLinks = container.querySelectorAll('a[href]');
      for (const link of allContainerLinks) {
        const href = link.getAttribute('href') || '';
        // Extract actual URL from Google redirects
        if (href.includes('url?url=')) {
          const m = href.match(/url\?url=([^&]+)/);
          if (m) { product_url = decodeURIComponent(m[1]); break; }
        } else if (href.includes('url?q=')) {
          const m = href.match(/url\?q=([^&]+)/);
          if (m) { product_url = decodeURIComponent(m[1]); break; }
        } else if (href.includes('/url?')) {
          // Other Google redirect patterns
          const m = href.match(/[?&](?:url|q)=([^&]+)/);
          if (m) { product_url = decodeURIComponent(m[1]); break; }
        }
      }
      // Fallback: Google Shopping product page link
      if (!product_url) {
        for (const link of allContainerLinks) {
          const href = link.getAttribute('href') || '';
          if (href.includes('/shopping/product/')) {
            product_url = href.startsWith('http') ? href : 'https://www.google.com' + href;
            break;
          }
        }
      }
      // Last resort: any external http link (not google internal)
      if (!product_url) {
        for (const link of allContainerLinks) {
          const href = link.getAttribute('href') || '';
          if (href.startsWith('http') && !href.includes('google.com/search') && !href.includes('accounts.google') && !href.includes('chrome-extension://')) {
            product_url = href;
            break;
          }
        }
      }

      // Retailer: scan for known retailer names in card text
      let retailer = '';
      const lowerText = cardText.toLowerCase();
      const retailerList = [
        ['temu', 'Temu'], ['poshmark', 'Poshmark'], ['walmart', 'Walmart'],
        ['shein', 'SHEIN'], ['target', 'Target'], ['thredup', 'ThredUp'],
        ['urban outfitt', 'Urban Outfitters'], ['mooyius', 'Mooyius'],
        ['banana repub', 'Banana Republic'], ['nordstrom', 'Nordstrom'],
        ['h&m', 'H&M'], ['asos', 'ASOS'], ['zara', 'Zara'],
        ['amazon', 'Amazon'], ['ebay', 'eBay'], ['etsy', 'Etsy'],
        ['macy', 'Macys'], ['kohls', 'Kohls'], ['jcpenney', 'JCPenney']
      ];
      for (const [key, name] of retailerList) {
        if (lowerText.includes(key)) { retailer = name; break; }
      }
      // Fallback: extract from URL domain
      if (!retailer && product_url) {
        try {
          const domain = new URL(product_url).hostname.replace('www.', '');
          retailer = domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
        } catch (e) {}
      }

      results.push({ title, price, image_url, product_url, retailer });
      if (results.length >= 15) break;
    } catch (e) {
      debug.push(`Error: ${e.message}`);
    }
  }

  debug.push(`Price-based extraction found: ${results.length} results`);

  // Debug fallback: if nothing found, dump page structure
  if (results.length === 0) {
    const allLeafText = [];
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length === 0 && el.textContent.trim().length > 3) {
        allLeafText.push(el.textContent.trim().substring(0, 60));
      }
    });
    debug.push(`Leaf text elements: ${allLeafText.length}`);
    debug.push(`Sample: ${allLeafText.slice(0, 30).join(' | ')}`);
    debug.push(`Body length: ${document.body?.textContent?.length || 0}`);
    debug.push(`Anchors: ${document.querySelectorAll('a').length}`);
    debug.push(`Images: ${document.querySelectorAll('img').length}`);
  }

  console.log('[compare-extract] Debug:', debug.join(' | '));
  console.log('[compare-extract] Results:', JSON.stringify(results.map(r => ({ title: (r.title || '').substring(0, 40), price: r.price, retailer: r.retailer }))));
  return results;
}

console.log("[GeminiTryOnMe] Background service worker started.");
