// @ts-check
// tubeRequest — one function exposes the tube.
// POST the request, get a location back, poll for the result.
// The provider doesn't know about JWTs, S3, or idempotency. It just awaits.

import crypto from "node:crypto";

/**
 * @typedef {object} TubeReceipt
 * @property {string} status — "Noted" (async) or "OK" (sync)
 * @property {string} requestId — locker ID (Lambda request ID)
 * @property {string} [location] — presigned GET for result/status.json
 * @property {string} [prefix] — S3 prefix of the locker
 * @property {{ url: string, fields: Record<string, string> }} [write] — presigned POST for uploads
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

  // 200 = sync result (processor response, passed through by ticket machine)
  if (response.status === 200) {
    return response.json();
  }

  // 202 = accepted, poll for result
  if (response.status === 202) {
    const receipt = await response.json();
    const requestId = receipt.locker || receipt.requestId;

    if (!shouldPoll) return /** @type {TubeReceipt} */ ({ status: receipt.status, requestId, location: receipt.result });

    // Poll the presigned result URL from the ticket machine
    const resultUrl = receipt.result;
    if (!resultUrl) {
      throw new TubeError(`tubeRequest: 202 but no result URL in response`, requestId);
    }

    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL);

      // Result URL is presigned — no auth headers needed
      const check = await fetch(resultUrl);

      if (check.status === 200) {
        const contentType = check.headers.get("content-type") || "";
        if (contentType.includes("json")) return check.json();
        return { content: await check.text(), contentType };
      }

      // 403 or 404 = not ready yet (S3 returns 403 for missing keys with presigned URLs)
      if (check.status !== 404 && check.status !== 403) {
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

/**
 * Upload files through the tube. One ticket, N files.
 * Gets a ticket (presigned POST), uploads each file, polls for result.
 *
 * @param {string} path — tube path (e.g. "share/add")
 * @param {Array<{ name: string, data: Buffer, contentType?: string }>} files
 * @param {Record<string, unknown>} [params] — metadata for the ticket request
 * @param {TubeRequestOptions} [opts]
 * @returns {Promise<unknown>} — processor result
 */
tubeRequest.upload = async (path, files, params = {}, opts = {}) => {
  const timeout = opts.timeout ?? POLL_TIMEOUT;

  // Get a ticket
  const receipt = /** @type {TubeReceipt} */ (await tubeRequest(path, {
    ...params,
    count: files.length,
    file: files[0]?.name || "upload",
  }, { poll: false }));

  if (!receipt.write) {
    throw new TubeError("tubeRequest.upload: no write URL in receipt", receipt.requestId);
  }

  const { url: postUrl, fields } = receipt.write;

  // Upload each file using presigned POST (multipart form)
  let uploaded = 0;
  for (const file of files) {
    const boundary = `----TubeUpload${Date.now()}${Math.random().toString(36).slice(2)}`;
    const parts = [];

    // Policy fields first
    for (const [k, v] of Object.entries(fields)) {
      const value = k === "key" ? v.replace("${filename}", file.name) : v;
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${value}`);
    }
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="Content-Type"\r\n\r\n${file.contentType || "application/octet-stream"}`);

    // File field last
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.contentType || "application/octet-stream"}\r\n\r\n`;
    const fileFooter = `\r\n--${boundary}--\r\n`;

    const bodyParts = Buffer.concat([
      Buffer.from(parts.join("\r\n") + "\r\n"),
      Buffer.from(fileHeader),
      file.data,
      Buffer.from(fileFooter),
    ]);

    const uploadResponse = await fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: bodyParts,
    });

    if (uploadResponse.ok) uploaded++;
  }

  if (uploaded === 0) {
    throw new TubeError("tubeRequest.upload: all uploads failed", receipt.requestId);
  }

  // Poll for result
  if (opts.poll === false) return { uploaded, total: files.length, resultUrl: receipt.location };

  const resultUrl = receipt.location;
  if (!resultUrl) return { uploaded, total: files.length };

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);
    const check = await fetch(resultUrl);
    if (check.status === 200) return check.json();
    if (check.status !== 404 && check.status !== 403) break;
  }

  return { pending: true, uploaded, total: files.length, resultUrl };
};

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
