// @ts-check
// tubeRequest — one function exposes the tube.
// POST the request, get a location back, poll for the result.
// The provider doesn't know about JWTs, S3, or idempotency. It just awaits.

import crypto from "node:crypto";

/**
 * @typedef {object} TubeReceipt
 * @property {string} status
 * @property {string} requestId
 * @property {string} location
 */

/**
 * @typedef {object} TubeRequestOptions
 * @property {number} [timeout] — poll timeout in ms (default 10s)
 * @property {boolean} [poll] — whether to poll for result (default true)
 */

// Config
const TUBE_URL = process.env.TUBE_URL || "https://thetube.today/tube";
const POLL_INTERVAL = process.env.POLL_INTERVAL ? parseInt(process.env.POLL_INTERVAL) : 200;
const POLL_TIMEOUT = process.env.POLL_TIMEOUT ? parseInt(process.env.POLL_TIMEOUT) : 10_000;
const FS_URL = process.env.FS_URL || "https://thetube.today/fs";

// Auth — loaded once from Keychain or env
/** @type {string | null} */
let _token = process.env.TUBE_TOKEN || null;
/** @type {string | null} */
let _secret = process.env.TUBE_SECRET || null;

/**
 * Load auth credentials from Keychain or environment.
 * @returns {Promise<void>}
 */
async function loadAuth() {
  if (_token && _secret) return;

  // Try Keychain (macOS)
  try {
    const { execSync } = await import("node:child_process");
    _token = execSync('security find-generic-password -a "thetube" -s "share-token-mac" -w', { encoding: "utf8" }).trim();
    _secret = execSync('security find-generic-password -a "thetube" -s "share-secret-mac" -w', { encoding: "utf8" }).trim();
  } catch {
    throw new Error("tubeRequest: no auth. Set TUBE_TOKEN + TUBE_SECRET or add to Keychain.");
  }
}

/**
 * Compute time-hash for request authentication.
 * @param {string} secret
 * @returns {{ timestamp: string, pass: string }}
 */
function computeTimeHash(secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const pass = crypto.createHash("sha256").update(`${secret}${timestamp}`).digest("hex");
  return { timestamp, pass };
}

/**
 * Route a request through the tube.
 *
 * POST to /tube/{path} with JWT auth, poll for the .result file.
 * The provider calls this instead of AWS SDK directly.
 *
 * @param {string} path — the tube path (e.g. "aws/describe-cloudfront")
 * @param {Record<string, unknown>} [params] — request parameters (sent as JSON body)
 * @param {TubeRequestOptions} [opts] — options
 * @returns {Promise<unknown>} — the result content (JSON-parsed)
 *
 * @example
 * const config = await tubeRequest("aws/describe-cloudfront", { distributionId: "E2D..." });
 *
 * @example
 * const lambdas = await tubeRequest("aws/list-lambdas", { maxItems: 10 });
 *
 * @example
 * // Fire-and-forget (returns receipt, doesn't poll)
 * const receipt = await tubeRequest.fire("share/add", { file: "IMG_1234.HEIC", type: "image" });
 */
export async function tubeRequest(path, params = {}, opts = {}) {
  await loadAuth();

  const { timestamp, pass } = computeTimeHash(/** @type {string} */ (_secret));
  const timeout = opts.timeout ?? POLL_TIMEOUT;
  const shouldPoll = opts.poll !== false;

  // POST to tube
  const url = `${TUBE_URL}/${path}`;
  const body = JSON.stringify(params);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${_token}`,
      "X-Pass": pass,
      "X-Timestamp": timestamp,
      "Content-Type": "application/json",
    },
    body,
  });

  // 200 = cached result (idempotent hit)
  if (response.status === 200) {
    return response.json();
  }

  // 202 = accepted, poll for result
  if (response.status === 202) {
    /** @type {TubeReceipt} */
    const receipt = await response.json();
    const { requestId, location } = receipt;

    if (!shouldPoll) return receipt;

    // Poll the result location
    const resultUrl = `${FS_URL}${location.replace(/^\/fs/, "").replace(".json", ".result")}`;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL);

      const check = await fetch(resultUrl, {
        headers: { "Authorization": `Bearer ${_token}` },
      });

      if (check.status === 200) {
        const contentType = check.headers.get("content-type") || "";
        if (contentType.includes("json")) return check.json();
        return { content: await check.text(), contentType };
      }

      // 404 = not ready yet, keep polling
      if (check.status !== 404) {
        throw new TubeError(`tubeRequest: unexpected status ${check.status} polling ${resultUrl}`, requestId);
      }
    }

    throw new TubeError(`tubeRequest: timeout after ${timeout}ms waiting for ${path}`, requestId);
  }

  // 403 = auth failed
  if (response.status === 403) {
    const err = await response.json().catch(() => ({}));
    throw new TubeError(`tubeRequest: auth failed — ${err.error || response.statusText}`, null);
  }

  throw new TubeError(`tubeRequest: unexpected ${response.status} from tube`, null);
}

/**
 * Fire-and-forget. POST to tube, don't wait for result.
 * Returns the receipt (requestId + location).
 *
 * @param {string} path
 * @param {Record<string, unknown>} [params]
 * @returns {Promise<TubeReceipt>}
 */
tubeRequest.fire = (path, params = {}) => /** @type {Promise<TubeReceipt>} */ (tubeRequest(path, params, { poll: false }));

// --- Error class ---

export class TubeError extends Error {
  /** @type {string | null} */
  requestId;

  /**
   * @param {string} message
   * @param {string | null} requestId
   */
  constructor(message, requestId) {
    super(message);
    this.name = "TubeError";
    this.requestId = requestId;
  }
}

// --- Helpers ---

/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
