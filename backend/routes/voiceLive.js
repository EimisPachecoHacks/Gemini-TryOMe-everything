/**
 * Voice Live WebSocket Route — Vertex AI Gemini Live API Proxy
 *
 * Proxies bidirectional audio between browser WebSocket and Gemini Live API
 * using the @google/genai SDK with Vertex AI authentication.
 *
 * Frontend sends Gemini-native format messages; backend translates to SDK calls.
 */

const { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } = require("@google/genai");
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

function sendJSON(ws, msg) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

function sendBinary(ws, data) {
  if (ws.readyState === 1) {
    ws.send(data, { binary: true });
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

  ws.on("message", async (data, isBinary) => {
    // --- Binary message = raw PCM audio from mic ---
    if (isBinary) {
      if (!session || !sessionReady || pendingToolCall) return;
      try {
        session.sendRealtimeInput({
          audio: {
            data: Buffer.from(data).toString("base64"),
            mimeType: "audio/pcm;rate=16000",
          },
        });
      } catch (e) {
        console.warn("[voice-live] Error sending audio:", e.message);
      }
      return;
    }

    // --- Text message = JSON (setup, tool responses, client content) ---
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      sendJSON(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    // --- Setup message: connect to Gemini Live via Vertex AI SDK ---
    if (msg.setup) {
      if (session) {
        sendJSON(ws, { type: "error", message: "Session already started" });
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
            realtimeInputConfig: {
              automaticActivityDetection: {
                startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
                endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                prefixPaddingMs: 40,
                silenceDurationMs: 500,
              },
            },
          },
          callbacks: {
            onopen: () => {
              console.log("[voice-live] Connected to Gemini Live (Vertex AI)");
              sessionReady = true;
              sendJSON(ws, { setupComplete: true });
            },
            onmessage: (geminiMsg) => {
              handleGeminiMessage(ws, geminiMsg, (val) => { pendingToolCall = val; });
            },
            onerror: (e) => {
              console.error("[voice-live] Gemini error:", e.message || e);
              sendJSON(ws, { type: "error", message: "Voice session error" });
            },
            onclose: (e) => {
              console.log("[voice-live] Gemini closed — code:", e?.code, "reason:", e?.reason || "(none)");
              sessionReady = false;
              if (ws.readyState === 1) {
                ws.close(1000, "Gemini session ended");
              }
            },
          },
        });
      } catch (err) {
        console.error("[voice-live] Failed to connect to Gemini:", err.message);
        sendJSON(ws, { type: "error", message: "Failed to connect: " + err.message });
      }
      return;
    }

    if (!session || !sessionReady) return;

    // --- Tool response ---
    if (msg.toolResponse?.functionResponses) {
      try {
        const respSummary = msg.toolResponse.functionResponses.map(r => `${r.name}: ${JSON.stringify(r.response?.result || '').substring(0, 150)}`).join(', ');
        console.log(`[voiceLive] 📨 Client tool response → Gemini: ${respSummary}`);
        session.sendToolResponse({
          functionResponses: msg.toolResponse.functionResponses,
        });
        pendingToolCall = false;
        console.log("[voiceLive] Tool response sent — audio ungated");
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
function handleGeminiMessage(ws, msg, setPendingToolCall) {
  // Audio data — send as raw binary for performance
  if (msg.serverContent?.modelTurn?.parts) {
    for (const part of msg.serverContent.modelTurn.parts) {
      if (part.inlineData?.data) {
        // Send raw PCM bytes (decode base64 from SDK → binary to client)
        sendBinary(ws, Buffer.from(part.inlineData.data, "base64"));
      }
      if (part.text) {
        // Native audio model: text parts are internal reasoning — suppress
        // (don't forward to save bandwidth)
      }
    }
  }

  // Turn complete
  if (msg.serverContent?.turnComplete) {
    sendJSON(ws, { serverContent: { turnComplete: true } });
  }

  // Interrupted
  if (msg.serverContent?.interrupted) {
    sendJSON(ws, { serverContent: { interrupted: true } });
  }

  // Input transcription
  if (msg.serverContent?.inputTranscription?.text) {
    sendJSON(ws, {
      serverContent: { inputTranscription: { text: msg.serverContent.inputTranscription.text } },
    });
  }

  // Output transcription
  if (msg.serverContent?.outputTranscription?.text) {
    sendJSON(ws, {
      serverContent: { outputTranscription: { text: msg.serverContent.outputTranscription.text } },
    });
  }

  // Tool calls — forward to client for execution and gate audio
  if (msg.toolCall?.functionCalls) {
    setPendingToolCall(true);
    const callSummary = msg.toolCall.functionCalls.map(c => `${c.name}(${JSON.stringify(c.args || {}).substring(0, 200)})`).join(', ');
    console.log(`[voiceLive] 🔧 Gemini tool calls → client: ${callSummary}`);
    sendJSON(ws, {
      toolCall: { functionCalls: msg.toolCall.functionCalls },
    });
  }

  // Tool call cancellation
  if (msg.toolCallCancellation?.ids) {
    console.log(`[voiceLive] ❌ Tool calls cancelled: ${JSON.stringify(msg.toolCallCancellation.ids)}`);
    sendJSON(ws, {
      toolCallCancellation: { ids: msg.toolCallCancellation.ids },
    });
  }

  // Go away
  if (msg.goAway) {
    sendJSON(ws, { goAway: msg.goAway });
  }
}
