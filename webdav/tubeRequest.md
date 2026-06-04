---
title: tubeRequest
date: 2026-06-04
tags: [tech, src]
type: journal
audience: owner
status: journaling
coffee: 1
summary: The Node client. One function exposes the tube. POST the request, get a result. The provider doesn't know about JWTs, S3, or polling. It just awaits.
workflow: draft
deploy:
  type: module
  name: tubeRequest.js
  target: webdav/tubeRequest.js
  code: js
---

## One function

`tubeRequest("aws/describe-cloudfront", { distributionId: "E2D..." })` — that's it. The caller doesn't know about auth, lockers, presigned URLs, or polling. It sends a path and params, gets back a result.

Three modes:
- **Sync** (200) — ticket machine invokes processor inline, returns result. One round-trip.
- **Async** (202) — ticket machine creates a locker, returns a result URL. tubeRequest polls it.
- **Fire-and-forget** — `tubeRequest.fire()` returns the receipt without polling.

```js # src
import crypto from "node:crypto";

const TUBE_URL = process.env.TUBE_URL || "https://thetube.today/tube";
const POLL_INTERVAL = process.env.POLL_INTERVAL ? parseInt(process.env.POLL_INTERVAL) : 200;
const POLL_TIMEOUT = process.env.POLL_TIMEOUT ? parseInt(process.env.POLL_TIMEOUT) : 10_000;
```

## Auth

Reads JWT + secret from Keychain (Touch ID on Mac) or environment variables. Computes a time-hash for each request — `SHA256(secret + timestamp)`. Loaded once, cached for the process lifetime.

```js # src
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
```

## The request

POST to `/tube/{path}` with auth headers and JSON body. The ticket machine routes it. The response tells you what happened:

- 200 = sync, result is the body
- 202 = async, poll the result URL
- 403 = auth failed

For sync routes (all `aws/*`), the ticket machine invokes the processor inline and passes through its response. One HTTP call, one result. No polling, no locker awareness.

```js # src
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
      const check = await fetch(resultUrl); // presigned — no auth needed
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
```

## Fire-and-forget

Returns the receipt without polling. For captures and other write-and-walk-away calls.

```js # src
tubeRequest.fire = (path, params = {}) => tubeRequest(path, params, { poll: false });
```

## Upload

One ticket, N files. Gets a presigned POST policy from the ticket machine, uploads each file directly to S3, polls for the processor result.

```js # src
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
```

## Error and helpers

```js # src
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
```

[journey]:
prev: the-ticket-machine
next:
Started as direct AWS SDK calls in each WebDAV provider. Replaced with one function that routes everything through the tube. The provider doesn't hold AWS credentials — it just awaits tubeRequest(). Auth from Keychain, time-hash per request, ticket machine handles routing. Sync for reads (200, one round-trip), async for uploads (202, presigned POST, poll). The Node equivalent of send-tube.
