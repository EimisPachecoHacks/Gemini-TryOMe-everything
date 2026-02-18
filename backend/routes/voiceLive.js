/**
 * Voice Live WebSocket Route — Vertex AI Gemini Live API Proxy
 *
 * Proxies bidirectional audio between browser WebSocket and Gemini Live API
 * using the @google/genai SDK with Vertex AI authentication.
 *
 * Frontend sends Gemini-native format messages; backend translates to SDK calls.
 */

const { GoogleGenAI, Modality } = require("@google/genai");
const { buildSystemInstruction, GISELLE_TOOLS } = require("../services/giselleLive");

const PROJECT_ID = process.env.GCP_PROJECT_ID || "project-4213188d-5b34-47c7-84e";
const LOCATION = process.env.GCP_LOCATION || "us-central1";
const MODEL = "gemini-live-2.5-flash-native-audio";
const VOICE_NAME = "Aoede";

let aiClient = null;
function getClient() {
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      vertexai: true,
      project: PROJECT_ID,
      location: LOCATION,
    });
  }
  return aiClient;
}

function sendToClient(ws, msg) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * WebSocket connection handler.
 * Expects first message to be a setup message with user context.
 */
module.exports = async function handleConnection(ws, req) {
  console.log("[voice-live] New WebSocket connection");

  let session = null;
  let sessionReady = false;
  let pendingToolCall = false;

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      sendToClient(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    // --- Setup message: connect to Gemini Live via Vertex AI SDK ---
    if (msg.setup) {
      if (session) {
        sendToClient(ws, { type: "error", message: "Session already started" });
        return;
      }

      const userContext = msg.setup.userContext || {};
      console.log("[voice-live] Starting Vertex AI session for user:", userContext.name || "(unknown)");

      try {
        const ai = getClient();
        const systemInstruction = buildSystemInstruction(userContext);

        session = await ai.live.connect({
          model: MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: systemInstruction,
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: VOICE_NAME },
              },
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            tools: GISELLE_TOOLS,
          },
          callbacks: {
            onopen: () => {
              console.log("[voice-live] Connected to Gemini Live (Vertex AI)");
              sessionReady = true;
              sendToClient(ws, { setupComplete: true });
            },
            onmessage: (geminiMsg) => {
              handleGeminiMessage(ws, geminiMsg);
            },
            onerror: (e) => {
              console.error("[voice-live] Gemini error:", e.message || e);
              sendToClient(ws, { type: "error", message: "Voice session error" });
            },
            onclose: (e) => {
              console.log("[voice-live] Gemini closed — code:", e?.code, "reason:", e?.reason || "(none)");
              sessionReady = false;
              // Notify client so it can reconnect
              if (ws.readyState === 1) {
                ws.close(1000, "Gemini session ended");
              }
            },
          },
        });
      } catch (err) {
        console.error("[voice-live] Failed to connect to Gemini:", err.message);
        sendToClient(ws, { type: "error", message: "Failed to connect: " + err.message });
      }
      return;
    }

    if (!session || !sessionReady) return;

    // --- Audio input ---
    if (msg.realtimeInput?.mediaChunks) {
      if (pendingToolCall) return; // Gate audio during tool calls
      for (const chunk of msg.realtimeInput.mediaChunks) {
        try {
          session.sendRealtimeInput({
            audio: {
              data: chunk.data,
              mimeType: chunk.mimeType || "audio/pcm;rate=16000",
            },
          });
        } catch (e) {
          console.warn("[voice-live] Error sending audio:", e.message);
        }
      }
      return;
    }

    // --- Tool response ---
    if (msg.toolResponse?.functionResponses) {
      try {
        session.sendToolResponse({
          functionResponses: msg.toolResponse.functionResponses,
        });
        pendingToolCall = false;
        console.log("[voice-live] Tool response sent, audio ungated");
      } catch (e) {
        console.warn("[voice-live] Error sending tool response:", e.message);
      }
      return;
    }

    // --- Client content (text, images) ---
    if (msg.clientContent) {
      try {
        session.sendClientContent(msg.clientContent);
      } catch (e) {
        console.warn("[voice-live] Error sending client content:", e.message);
      }
      return;
    }
  });

  ws.on("close", () => {
    console.log("[voice-live] Client disconnected");
    if (session) {
      try {
        session.close();
      } catch (e) {
        console.warn("[voice-live] Error closing session:", e.message);
      }
      session = null;
      sessionReady = false;
    }
  });

  ws.on("error", (err) => {
    console.error("[voice-live] WebSocket error:", err.message);
  });

  // Heartbeat to keep Cloud Run connection alive
  const heartbeat = setInterval(() => {
    if (ws.readyState === 1) {
      ws.ping();
    } else {
      clearInterval(heartbeat);
    }
  }, 30000);

  ws.on("close", () => clearInterval(heartbeat));
};

/**
 * Forward Gemini Live messages to the client in the same native format.
 */
function handleGeminiMessage(ws, msg) {
  // Audio data
  if (msg.serverContent?.modelTurn?.parts) {
    for (const part of msg.serverContent.modelTurn.parts) {
      if (part.inlineData) {
        sendToClient(ws, {
          serverContent: {
            modelTurn: {
              parts: [{ inlineData: { data: part.inlineData.data, mimeType: part.inlineData.mimeType } }],
            },
          },
        });
      }
      if (part.text) {
        // Native audio model: text parts are internal reasoning — forward as-is
        // (frontend handles suppression)
        sendToClient(ws, {
          serverContent: {
            modelTurn: {
              parts: [{ text: part.text }],
            },
          },
        });
      }
    }
  }

  // Turn complete
  if (msg.serverContent?.turnComplete) {
    sendToClient(ws, { serverContent: { turnComplete: true } });
  }

  // Interrupted
  if (msg.serverContent?.interrupted) {
    sendToClient(ws, { serverContent: { interrupted: true } });
  }

  // Input transcription
  if (msg.serverContent?.inputTranscription?.text) {
    sendToClient(ws, {
      serverContent: { inputTranscription: { text: msg.serverContent.inputTranscription.text } },
    });
  }

  // Output transcription
  if (msg.serverContent?.outputTranscription?.text) {
    sendToClient(ws, {
      serverContent: { outputTranscription: { text: msg.serverContent.outputTranscription.text } },
    });
  }

  // Tool calls — gate audio input while tool is being processed
  if (msg.toolCall?.functionCalls) {
    pendingToolCall = true;
    sendToClient(ws, {
      toolCall: { functionCalls: msg.toolCall.functionCalls },
    });
  }

  // Tool call cancellation
  if (msg.toolCallCancellation?.ids) {
    sendToClient(ws, {
      toolCallCancellation: { ids: msg.toolCallCancellation.ids },
    });
  }

  // Go away
  if (msg.goAway) {
    sendToClient(ws, { goAway: msg.goAway });
  }
}
