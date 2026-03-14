const crypto = require("crypto");
const { Firestore } = require("@google-cloud/firestore");
const storage = require("./storage");

const CACHE_TTL_HOURS = parseInt(process.env.TRYON_CACHE_TTL_HOURS, 10) || 48;

// Use the same Firestore instance config
const firestoreOpts = {
  projectId: process.env.GCP_PROJECT_ID,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "gemini-tryonme-everything",
};
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  firestoreOpts.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
}
const db = new Firestore(firestoreOpts);
const COLLECTION = "tryOnCache";

/**
 * Build a deterministic cache key from single-item try-on inputs.
 * Uses first 16KB of garment image for the hash (enough to uniquely identify).
 */
function buildCacheKey(userId, referenceImage, garmentClass, framing, poseIndex) {
  const hash = crypto.createHash("sha256");
  hash.update(userId || "anon");
  hash.update((referenceImage || "").substring(0, 16384));
  hash.update(garmentClass || "");
  hash.update(framing || "full");
  hash.update(String(poseIndex ?? 0));
  return hash.digest("hex");
}

/**
 * Build cache key for outfit try-on (multiple garments).
 */
function buildOutfitCacheKey(userId, garments, framing, poseIndex) {
  const hash = crypto.createHash("sha256");
  hash.update(userId || "anon");
  for (const g of garments) {
    hash.update((g.imageBase64 || "").substring(0, 16384));
    hash.update(g.garmentClass || "");
  }
  hash.update(framing || "full");
  hash.update(String(poseIndex ?? 0));
  return hash.digest("hex");
}

/**
 * Look up a cached try-on result.
 * Returns the base64 result image string, or null if not cached / expired.
 */
async function getCached(cacheKey) {
  try {
    const doc = await db.collection(COLLECTION).doc(cacheKey).get();
    if (!doc.exists) return null;

    const data = doc.data();
    // Check TTL
    const expiresAt = data.expiresAt?.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt);
    if (expiresAt < new Date()) {
      // Expired — delete async and return null
      db.collection(COLLECTION).doc(cacheKey).delete().catch(() => {});
      return null;
    }

    // Fetch the cached image from GCS
    const base64 = await storage.downloadFileBase64(data.gcsKey);
    console.log(`[tryOnCache] ✅ Cache HIT: ${cacheKey.substring(0, 12)}... (${base64.length} chars)`);
    return base64;
  } catch (err) {
    console.warn(`[tryOnCache] GET failed: ${err.message}`);
    return null;
  }
}

/**
 * Store a try-on result in the cache.
 * Saves the image to GCS, then stores the GCS key in Firestore with TTL.
 */
async function setCached(cacheKey, resultImage, userId) {
  try {
    const gcsKey = `cache/${userId || "anon"}/${cacheKey}.jpg`;
    const buffer = Buffer.from(resultImage, "base64");
    await storage.uploadFile(gcsKey, buffer, "image/jpeg");

    const expiresAt = new Date(Date.now() + CACHE_TTL_HOURS * 60 * 60 * 1000);
    await db.collection(COLLECTION).doc(cacheKey).set({
      gcsKey,
      userId: userId || "anon",
      expiresAt,
      createdAt: new Date(),
    });
    console.log(`[tryOnCache] ✅ Cache SET: ${cacheKey.substring(0, 12)}... (expires ${expiresAt.toISOString()})`);
  } catch (err) {
    // Non-critical — just skip caching
    console.warn(`[tryOnCache] SET failed: ${err.message}`);
  }
}

module.exports = { buildCacheKey, buildOutfitCacheKey, getCached, setCached };
