const { fal } = require("@fal-ai/client");
const sharp = require("sharp");

const FAL_KEY = process.env.FAL_KEY;

let configured = false;

function ensureConfigured() {
  if (!configured) {
    if (!FAL_KEY) {
      throw new Error("FAL_KEY is not set in environment variables");
    }
    fal.config({ credentials: FAL_KEY });
    configured = true;
  }
}

const MODEL_ID = "xai/grok-imagine-video/image-to-video";

/**
 * Generate video from image using Grok Imagine Video via fal.ai
 * @param {string} imageBase64
 * @param {string} [prompt]
 * @param {string} [sex] - "male" or "female" for correct pronouns
 * Returns { requestId, provider } for polling
 */
async function generateVideo(imageBase64, prompt, sex) {
  console.log("[grok] generateVideo - starting video generation");

  ensureConfigured();

  // Resize image to 720x1280 (9:16 portrait) for fashion
  const imageBuffer = Buffer.from(imageBase64, "base64");
  const resizedBuffer = await sharp(imageBuffer)
    .resize(720, 1280, { fit: "cover" })
    .jpeg({ quality: 90 })
    .toBuffer();

  console.log("[grok] generateVideo - image resized to 720x1280 (9:16)");

  const imageDataUrl = `data:image/jpeg;base64,${resizedBuffer.toString("base64")}`;

  const pronoun = sex === "male" ? "He" : "She";
  const possessive = sex === "male" ? "his" : "her";
  const defaultPrompt =
    `The exact same person from the image slowly poses for a fashion photoshoot. ` +
    `${pronoun} makes subtle, gentle movements — a slight turn, a small weight shift, a soft head tilt — ` +
    `to show off the outfit from slightly different angles. ` +
    "Movements are minimal, slow, and elegant. The person stays mostly in place. " +
    "CRITICAL: The person's face, skin tone, hair, body shape, and all physical features must remain IDENTICAL to the input image throughout the entire video. Do NOT change, morph, or alter the person's appearance in any way. " +
    "Soft, ambient fashion music in the background.";

  const { request_id } = await fal.queue.submit(MODEL_ID, {
    input: {
      prompt: prompt || defaultPrompt,
      image_url: imageDataUrl,
      duration: 6,
      aspect_ratio: "9:16",
      resolution: "720p",
    },
  });

  console.log(`[grok] generateVideo - job submitted, requestId: ${request_id}`);
  return { requestId: request_id, provider: "grok" };
}

/**
 * Check video generation status and return video URL if complete
 */
async function getVideoStatus(requestId) {
  console.log(`[grok] getVideoStatus - checking: ${requestId}`);

  ensureConfigured();

  const status = await fal.queue.status(MODEL_ID, {
    requestId,
    logs: false,
  });

  console.log(`[grok] getVideoStatus - status: ${status.status}`);

  if (status.status === "COMPLETED") {
    const result = await fal.queue.result(MODEL_ID, { requestId });
    const videoUrl = result.data?.video?.url;
    console.log(`[grok] getVideoStatus - completed, video URL: ${videoUrl}`);
    return {
      status: "Completed",
      videoUrl,
      failureMessage: null,
    };
  }

  if (status.status === "FAILED") {
    const errorMsg = status.error || "Grok video generation failed";
    console.log(`[grok] getVideoStatus - failed: ${errorMsg}`);
    return {
      status: "Failed",
      failureMessage: errorMsg,
    };
  }

  // IN_QUEUE or IN_PROGRESS
  return {
    status: "InProgress",
    failureMessage: null,
  };
}

module.exports = { generateVideo, getVideoStatus };
