// tubeRequest — the Node client for the tube
// POST the request, get a result. No AWS credentials here.

import crypto from "node:crypto";

const TUBE_URL = process.env.TUBE_URL || "https://thetube.today/tube";
const POLL_INTERVAL = process.env.POLL_INTERVAL ? parseInt(process.env.POLL_INTERVAL) : 200;
const POLL_TIMEOUT = process.env.POLL_TIMEOUT ? parseInt(process.env.POLL_TIMEOUT) : 10_000;

let _token = process.env.TUBE_TOKEN || null;
let _secret = process.env.TUBE_SECRET || null;

async function loadAuth() {
  if (_token && _secret) return;

  try {
    const { execSync } = await import("node:child_process");
    _token = execSync('security find-generic-password -a "thetube" -s "share-token-mac" -w', { encoding: "utf8" }).trim();
    _secret = execSync('security find-generic-password -a "thetube" -s "share-secret-mac" -w', { encoding: "utf8" }).trim();
  } catch {
    throw new Error("tubeRequest: no auth. Set TUBE_TOKEN + TUBE_SECRET or add to Keychain.");
  }
}

function computeTimeHash(secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const pass = crypto.createHash("sha256").update(`${secret}${timestamp}`).digest("hex");
  return { timestamp, pass };
}

export async function tubeRequest(path, params = {}, opts = {}) {
  await loadAuth();

  const { timestamp, pass } = computeTimeHash(_secret);
  const timeout = opts.timeout ?? POLL_TIMEOUT;
  const shouldPoll = opts.poll !== false;

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

  // Sync — processor responded inline
  if (response.status === 200) {
    return response.json();
  }

  // Async — poll the result URL
  if (response.status === 202) {
    const receipt = await response.json();
    const requestId = receipt.locker || receipt.requestId;

    if (!shouldPoll) return { status: receipt.status, requestId, location: receipt.result, write: receipt.write };

    const resultUrl = receipt.result;
    if (!resultUrl) {
      throw new TubeError(`tubeRequest: 202 but no result URL`, requestId);
    }

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL);
      const check = await fetch(resultUrl);
      if (check.status === 200) {
        const contentType = check.headers.get("content-type") || "";
        if (contentType.includes("json")) return check.json();
        return { content: await check.text(), contentType };
      }
      if (check.status !== 404 && check.status !== 403) {
        throw new TubeError(`tubeRequest: unexpected ${check.status} polling`, requestId);
      }
    }
    throw new TubeError(`tubeRequest: timeout after ${timeout}ms waiting for ${path}`, requestId);
  }

  if (response.status === 403) {
    const err = await response.json().catch(() => ({}));
    throw new TubeError(`tubeRequest: auth failed — ${err.error || response.statusText}`, null);
  }

  throw new TubeError(`tubeRequest: unexpected ${response.status}`, null);
}

tubeRequest.fire = (path, params = {}) => tubeRequest(path, params, { poll: false });

tubeRequest.upload = async (path, files, params = {}, opts = {}) => {
  const timeout = opts.timeout ?? POLL_TIMEOUT;

  const receipt = await tubeRequest(path, {
    ...params,
    count: files.length,
    file: files[0]?.name || "upload",
  }, { poll: false });

  if (!receipt.write) {
    throw new TubeError("tubeRequest.upload: no write URL in receipt", receipt.requestId);
  }

  const { url: postUrl, fields } = receipt.write;

  let uploaded = 0;
  for (const file of files) {
    const boundary = `----TubeUpload${Date.now()}${Math.random().toString(36).slice(2)}`;
    const parts = [];

    for (const [k, v] of Object.entries(fields)) {
      const value = k === "key" ? v.replace("${filename}", file.name) : v;
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${value}`);
    }
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="Content-Type"\r\n\r\n${file.contentType || "application/octet-stream"}`);

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

export class TubeError extends Error {
  constructor(message, requestId) {
    super(message);
    this.name = "TubeError";
    this.requestId = requestId;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
