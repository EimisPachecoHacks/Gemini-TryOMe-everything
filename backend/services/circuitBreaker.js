/**
 * Simple circuit breaker for external API calls (e.g. Gemini).
 *
 * States:
 *   CLOSED   — normal operation, requests flow through
 *   OPEN     — too many recent failures, requests are rejected immediately
 *   HALF_OPEN — after cooldown, one probe request is allowed through
 *
 * Configuration via environment variables:
 *   CIRCUIT_BREAKER_THRESHOLD  — consecutive failures before opening (default 5)
 *   CIRCUIT_BREAKER_COOLDOWN   — ms before trying again after opening (default 30000)
 */

const THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || "5", 10);
const COOLDOWN_MS = parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN || "30000", 10);

const STATE = { CLOSED: "CLOSED", OPEN: "OPEN", HALF_OPEN: "HALF_OPEN" };

// Per-service circuit state
const circuits = {};

function getCircuit(name) {
  if (!circuits[name]) {
    circuits[name] = {
      state: STATE.CLOSED,
      failures: 0,
      lastFailureTime: 0,
    };
  }
  return circuits[name];
}

/**
 * Wrap an async function with circuit breaker protection.
 *
 * @param {string} name  — circuit name (e.g. "gemini", "imageProcessor")
 * @param {Function} fn  — async function to execute
 * @returns {Promise<*>} — result of fn()
 * @throws {Error} — if circuit is open, throws "Service unavailable" instead of calling fn
 */
/**
 * Check if an error is a 429 Too Many Requests error.
 */
function is429(err) {
  if (err?.status === 429 || err?.statusCode === 429) return true;
  if (err?.code === 429) return true;
  const msg = (err?.message || "").toLowerCase();
  return msg.includes("429") || msg.includes("too many requests") || msg.includes("resource exhausted") || msg.includes("rate limit");
}

const RETRY_429_MAX = 3;
const RETRY_429_BASE_DELAY_MS = 2000; // 2s, 4s, 8s exponential backoff

async function withCircuitBreaker(name, fn) {
  const circuit = getCircuit(name);

  // OPEN: reject immediately unless cooldown has elapsed
  if (circuit.state === STATE.OPEN) {
    const elapsed = Date.now() - circuit.lastFailureTime;
    if (elapsed < COOLDOWN_MS) {
      const waitSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      throw new Error(
        `Service temporarily unavailable (circuit open for "${name}"). Retry in ~${waitSec}s.`
      );
    }
    // Cooldown elapsed → transition to HALF_OPEN (allow one probe)
    circuit.state = STATE.HALF_OPEN;
    console.log(`[circuitBreaker] ${name}: OPEN → HALF_OPEN (probe request allowed)`);
  }

  // Attempt with 429 retry (up to 3 retries with exponential backoff)
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_429_MAX; attempt++) {
    try {
      const result = await fn();

      // Success → reset circuit
      if (circuit.state !== STATE.CLOSED) {
        console.log(`[circuitBreaker] ${name}: ${circuit.state} → CLOSED (success)`);
      }
      circuit.state = STATE.CLOSED;
      circuit.failures = 0;
      return result;
    } catch (err) {
      lastErr = err;

      // 429 retry — only retry rate limit errors, not other failures
      if (is429(err) && attempt < RETRY_429_MAX) {
        const delay = RETRY_429_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[circuitBreaker] ${name}: 429 rate limited (attempt ${attempt + 1}/${RETRY_429_MAX + 1}), retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Non-429 error or exhausted retries — record failure
      circuit.failures++;
      circuit.lastFailureTime = Date.now();

      if (is429(err) && attempt >= RETRY_429_MAX) {
        console.error(`[circuitBreaker] ${name}: 429 rate limited — exhausted all ${RETRY_429_MAX} retries`);
      }

      // If we were probing (HALF_OPEN) and it failed → back to OPEN
      if (circuit.state === STATE.HALF_OPEN) {
        circuit.state = STATE.OPEN;
        console.warn(`[circuitBreaker] ${name}: HALF_OPEN → OPEN (probe failed: ${err.message})`);
      } else if (circuit.failures >= THRESHOLD) {
        circuit.state = STATE.OPEN;
        console.warn(
          `[circuitBreaker] ${name}: CLOSED → OPEN (${circuit.failures} consecutive failures)`
        );
      }

      throw err;
    }
  }

  throw lastErr;
}

/**
 * Get current circuit status (useful for health checks).
 */
function getStatus(name) {
  const circuit = getCircuit(name);
  return {
    name,
    state: circuit.state,
    failures: circuit.failures,
    lastFailureTime: circuit.lastFailureTime,
  };
}

module.exports = { withCircuitBreaker, getStatus };
