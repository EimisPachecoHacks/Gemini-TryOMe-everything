const { GoogleGenAI } = require("@google/genai");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const os = require("os");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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
 * Retry a function up to 3 times on 429 errors with exponential backoff.
 */
async function retry429(fn, label = "api") {
  const MAX = 3;
  const BASE_MS = 2000;
  let lastErr;
  for (let i = 0; i <= MAX; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = (err?.message || "").toLowerCase();
      const is429 = err?.status === 429 || err?.statusCode === 429 || msg.includes("429") || msg.includes("too many requests") || msg.includes("resource exhausted") || msg.includes("rate limit");
      if (is429 && i < MAX) {
        const delay = BASE_MS * Math.pow(2, i);
        console.warn(`[${label}] 429 rate limited (attempt ${i + 1}/${MAX + 1}), retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

const VEO_MODEL = "veo-3.1-generate-preview";
const POLL_INTERVAL_MS = 10000; // 10 seconds between polls
const MAX_POLL_ATTEMPTS = 60; // 10 minutes max wait

/**
 * Generate a fashion video from a try-on result image using Google Veo 3.1.
 * Unlike Grok (async polling via fal.ai), Veo uses the Gemini API's
 * generateVideos + operations polling pattern.
 *
 * This function is SYNCHRONOUS from the caller's perspective — it polls
 * until the video is ready and returns the video as a base64 string.
 *
 * @param {string} imageBase64 - The try-on result image
 * @param {string} [prompt] - Custom prompt (uses fashion default if omitted)
 * @param {string} [sex] - "male" or "female" for correct pronouns
 * @returns {{ videoBase64: string }} - The generated video as base64
 */
async function generateVideo(imageBase64, prompt, sex) {
  console.log("[veo] generateVideo - starting Veo 3.1 video generation");

  const ai = getClient();

  // Resize image to 720x1280 (9:16 portrait) for fashion
  const imageBuffer = Buffer.from(imageBase64, "base64");
  const resizedBuffer = await sharp(imageBuffer)
    .resize(720, 1280, { fit: "cover" })
    .png()
    .toBuffer();

  console.log("[veo] generateVideo - image resized to 720x1280 (9:16)");

  const pronoun = sex === "male" ? "He" : "She";
  const possessive = sex === "male" ? "his" : "her";
  const defaultPrompt =
    `Animate the person in the image as a professional fashion model presenting ${possessive} outfit on a runway photoshoot. ` +
    `${pronoun} confidently poses and slowly transitions between elegant poses — turning slightly, shifting weight, ` +
    `tilting head, and adjusting posture to showcase the clothing from different angles. ` +
    "The movements should be smooth, natural, and graceful like a high-end fashion commercial. " +
    "CRITICAL IDENTITY PRESERVATION: The person's face, facial features, skin tone, hair color, hair style, body shape, and body proportions must remain EXACTLY as shown in the input image throughout the entire video. " +
    "Do NOT alter, exaggerate, slim, widen, or modify any physical features. The person in every frame must be clearly recognizable as the same person in the input image.";

  const finalPrompt = prompt || defaultPrompt;

  // Submit the video generation job using image as first-frame reference (with 429 retry)
  let operation = await retry429(() => ai.models.generateVideos({
    model: VEO_MODEL,
    prompt: finalPrompt,
    image: {
      imageBytes: resizedBuffer.toString("base64"),
      mimeType: "image/png",
    },
    config: {
      aspectRatio: "9:16",
      durationSeconds: 6,
      numberOfVideos: 1,
      personGeneration: "allow_adult",
    },
  }), "veo");

  console.log("[veo] generateVideo - job submitted, polling for completion...");

  // Poll until done
  let attempts = 0;
  while (!operation.done) {
    if (attempts >= MAX_POLL_ATTEMPTS) {
      throw new Error("Veo video generation timed out after 10 minutes");
    }
    attempts++;
    console.log(`[veo] generateVideo - poll attempt ${attempts}/${MAX_POLL_ATTEMPTS}...`);

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    operation = await ai.operations.getVideosOperation({
      operation: operation,
    });
  }

  console.log("[veo] generateVideo - generation complete!");

  // Download the generated video to a temp file, then read as base64
  const generatedVideos = operation.response?.generatedVideos;
  if (!generatedVideos || generatedVideos.length === 0) {
    throw new Error("Veo returned no videos");
  }

  const video = generatedVideos[0].video;
  if (!video) {
    throw new Error("Veo video object is empty");
  }

  const tmpPath = path.join(os.tmpdir(), `veo_${Date.now()}.mp4`);
  try {
    await ai.files.download({
      file: video,
      downloadPath: tmpPath,
    });

    console.log(`[veo] generateVideo - video downloaded to ${tmpPath}`);

    const videoBuffer = fs.readFileSync(tmpPath);
    const videoBase64 = videoBuffer.toString("base64");

    console.log(`[veo] generateVideo - video size: ${videoBuffer.length} bytes`);

    return { videoBase64 };
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

module.exports = { generateVideo };
