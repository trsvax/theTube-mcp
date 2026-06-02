// tube provider — local filesystem + remote via tubeRequest
// Local: direct fs reads/writes (the Mac is the tube's local half)
// S3: routes through tubeRequest (no AWS credentials here)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { tubeRequest } from "../tubeRequest.js";

// Local tube storage
const TUBE_DIR = process.env.TUBE_DIR || path.join(process.env.HOME || "/tmp", ".tube");

// --- Local helpers ---

function ensureTubeDir(...parts) {
  const dir = path.join(TUBE_DIR, ...parts);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function localListApps() {
  ensureTubeDir();
  return fs.readdirSync(TUBE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function localListActions(app) {
  const dir = path.join(TUBE_DIR, app);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function localListFiles(app, action) {
  const dir = path.join(TUBE_DIR, app, action);
  if (!fs.existsSync(dir)) return [];
  const files = [];
  function walk(d, prefix) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(d, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        const stat = fs.statSync(path.join(d, entry.name));
        files.push({
          name: prefix ? `${prefix}/${entry.name}` : entry.name,
          size: stat.size,
          modified: stat.mtime.toUTCString(),
          type: entry.name.endsWith(".json") || entry.name.endsWith(".request") ? "application/json" : "application/octet-stream",
        });
      }
    }
  }
  walk(dir, "");
  return files;
}

function localReadFile(app, action, filename) {
  const filepath = path.join(TUBE_DIR, app, action, filename);
  if (!fs.existsSync(filepath)) return null;
  return fs.readFileSync(filepath, "utf-8");
}

function localWriteRequest(app, action, requestId, metadata, body) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const dir = ensureTubeDir(app, action, String(yyyy), mm, dd);
  fs.writeFileSync(path.join(dir, `${requestId}.request`), JSON.stringify(metadata, null, 2));
  if (body && body.length > 0) {
    fs.writeFileSync(path.join(dir, `${requestId}.body`), body);
  }
}

// --- PROPFIND ---

export function propfind(url, basePath, { dirResponse, fileResponse }) {
  if (url === `${basePath}/tube`) {
    const responses = [
      dirResponse(`${basePath}/tube/`, "tube"),
      dirResponse(`${basePath}/tube/local/`, "local"),
      dirResponse(`${basePath}/tube/s3/`, "s3"),
    ];
    return { handled: true, responses };
  }

  if (url === `${basePath}/tube/local`) {
    const apps = localListApps();
    const responses = [
      dirResponse(`${basePath}/tube/local/`, "local"),
      ...apps.map(a => dirResponse(`${basePath}/tube/local/${a}/`, a)),
    ];
    return { handled: true, responses };
  }

  const localAppMatch = url.match(new RegExp(`^${basePath}/tube/local/([^/]+)$`));
  if (localAppMatch) {
    const app = localAppMatch[1];
    const actions = localListActions(app);
    const responses = [
      dirResponse(`${basePath}/tube/local/${app}/`, app),
      ...actions.map(a => dirResponse(`${basePath}/tube/local/${app}/${a}/`, a)),
    ];
    return { handled: true, responses };
  }

  const localActionMatch = url.match(new RegExp(`^${basePath}/tube/local/([^/]+)/([^/]+)$`));
  if (localActionMatch) {
    const [, app, action] = localActionMatch;
    const files = localListFiles(app, action);
    const responses = [
      dirResponse(`${basePath}/tube/local/${app}/${action}/`, action),
      ...files.map(r => fileResponse(
        `${basePath}/tube/local/${app}/${action}/${r.name}`, r.name, r.size, r.modified, r.type
      )),
    ];
    return { handled: true, responses };
  }

  // S3 tube paths — via tubeRequest
  if (url === `${basePath}/tube/s3`) {
    return { handled: true, async: true, fn: async () => {
      const apps = await tubeRequest("aws/list-tube-apps");
      return [
        dirResponse(`${basePath}/tube/s3/`, "s3"),
        ...(apps || []).map(a => dirResponse(`${basePath}/tube/s3/${a}/`, a)),
      ];
    }};
  }

  const s3AppMatch = url.match(new RegExp(`^${basePath}/tube/s3/([^/]+)$`));
  if (s3AppMatch) {
    const app = s3AppMatch[1];
    return { handled: true, async: true, fn: async () => {
      const actions = await tubeRequest("aws/list-tube-actions", { app });
      return [
        dirResponse(`${basePath}/tube/s3/${app}/`, app),
        ...(actions || []).map(a => dirResponse(`${basePath}/tube/s3/${app}/${a}/`, a)),
      ];
    }};
  }

  const s3ActionMatch = url.match(new RegExp(`^${basePath}/tube/s3/([^/]+)/([^/]+)$`));
  if (s3ActionMatch) {
    const [, app, action] = s3ActionMatch;
    return { handled: true, async: true, fn: async () => {
      const files = await tubeRequest("aws/list-tube-files", { app, action });
      return [
        dirResponse(`${basePath}/tube/s3/${app}/${action}/`, action),
        ...(files || []).map(r => fileResponse(
          `${basePath}/tube/s3/${app}/${action}/${r.name}`, r.name, r.size, r.modified, r.type
        )),
      ];
    }};
  }

  return { handled: false };
}

// --- GET ---

export async function get(url, basePath) {
  // Local files
  const localFileMatch = url.match(new RegExp(`^${basePath}/tube/local/([^/]+)/([^/]+)/(.+)$`));
  if (localFileMatch) {
    const [, app, action, filename] = localFileMatch;
    const content = localReadFile(app, action, filename);
    if (content === null) return { handled: true, notFound: true };
    const contentType = filename.endsWith(".json") || filename.endsWith(".request") ? "application/json" : "application/octet-stream";
    return { handled: true, content, contentType };
  }

  // S3 files — via tubeRequest
  const s3FileMatch = url.match(new RegExp(`^${basePath}/tube/s3/([^/]+)/([^/]+)/(.+)$`));
  if (s3FileMatch) {
    const [, app, action, filename] = s3FileMatch;
    const result = await tubeRequest("aws/read-tube-file", { app, action, filename });
    if (!result) return { handled: true, notFound: true };
    const content = typeof result === "string" ? result : result?.content || "";
    const contentType = filename.endsWith(".json") ? "application/json" : "application/octet-stream";
    return { handled: true, content, contentType };
  }

  return { handled: false };
}

// --- POST (writes to local) ---

export function post(req, url, basePath) {
  const rawUrl = req.url;
  const urlPath = rawUrl.split("?")[0];
  const tubeMatch = urlPath.match(new RegExp(`^${basePath}/tube/(?:local/)?(.+)$`));
  if (!tubeMatch) return { handled: false };

  const tubePath = tubeMatch[1];
  if (tubePath.startsWith("s3/")) return { handled: false };

  const parts = tubePath.split("/");
  const app = parts[0];
  const action = parts.slice(1).join("/") || "default";
  const requestId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

  return {
    handled: true,
    handler: (res) => {
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const queryString = rawUrl.includes("?") ? rawUrl.split("?")[1] : null;

        const metadata = {
          requestId,
          path: tubePath,
          method: "POST",
          timestamp: new Date().toISOString(),
          query: queryString ? Object.fromEntries(new URLSearchParams(queryString)) : null,
          headers: {
            "content-type": req.headers["content-type"],
            "user-agent": req.headers["user-agent"],
            "authorization": req.headers["authorization"] ? "[present]" : null,
          },
          bodySize: body.length,
        };

        localWriteRequest(app, action, requestId, metadata, body.length > 0 ? body : null);

        const now = new Date();
        const yyyy = now.getUTCFullYear();
        const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(now.getUTCDate()).padStart(2, "0");
        const location = `${basePath}/tube/local/${app}/${action}/${yyyy}/${mm}/${dd}/${requestId}.request`;
        res.writeHead(202, {
          "Content-Type": "application/json",
          "Location": location,
          "X-Request-Id": requestId,
        });
        res.end(JSON.stringify({ status: "Noted", requestId, location }));
      });
    },
  };
}
