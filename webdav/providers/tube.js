import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { cached } from "../cache.js";

// Local tube storage
const TUBE_DIR = process.env.TUBE_DIR || path.join(process.env.HOME || "/tmp", ".tube");

// S3 tube storage
const TUBE_BUCKET = process.env.TUBE_BUCKET || "thetube-today";
const TUBE_PREFIX = process.env.TUBE_PREFIX || "tube/";

const s3 = new S3Client({});

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

// --- S3 helpers ---

async function s3ListApps() {
  return cached("tube-s3-apps", async () => {
    try {
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: TUBE_BUCKET, Prefix: TUBE_PREFIX, Delimiter: "/", MaxKeys: 100,
      }));
      return (resp.CommonPrefixes || []).map(p => p.Prefix.replace(TUBE_PREFIX, "").replace(/\/$/, ""));
    } catch { return []; }
  });
}

async function s3ListActions(app) {
  return cached(`tube-s3-actions-${app}`, async () => {
    try {
      const prefix = `${TUBE_PREFIX}${app}/`;
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: TUBE_BUCKET, Prefix: prefix, Delimiter: "/", MaxKeys: 100,
      }));
      return (resp.CommonPrefixes || []).map(p => p.Prefix.replace(prefix, "").replace(/\/$/, ""));
    } catch { return []; }
  });
}

async function s3ListFiles(app, action) {
  return cached(`tube-s3-files-${app}-${action}`, async () => {
    try {
      const prefix = `${TUBE_PREFIX}${app}/${action}/`;
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: TUBE_BUCKET, Prefix: prefix, MaxKeys: 200,
      }));
      return (resp.Contents || []).map(obj => ({
        name: obj.Key.replace(prefix, ""),
        size: obj.Size,
        modified: obj.LastModified?.toUTCString() || "",
        type: obj.Key.endsWith(".json") ? "application/json" : "application/octet-stream",
      }));
    } catch { return []; }
  });
}

async function s3ReadFile(app, action, filename) {
  try {
    const key = `${TUBE_PREFIX}${app}/${action}/${filename}`;
    const resp = await s3.send(new GetObjectCommand({ Bucket: TUBE_BUCKET, Key: key }));
    return await resp.Body.transformToString("utf-8");
  } catch { return null; }
}

// --- PROPFIND ---

export function propfind(url, basePath, { dirResponse, fileResponse }) {
  // /fs/tube/
  if (url === `${basePath}/tube`) {
    const responses = [
      dirResponse(`${basePath}/tube/`, "tube"),
      dirResponse(`${basePath}/tube/local/`, "local"),
      dirResponse(`${basePath}/tube/s3/`, "s3"),
    ];
    return { handled: true, responses };
  }

  // /fs/tube/local/
  if (url === `${basePath}/tube/local`) {
    const apps = localListApps();
    const responses = [
      dirResponse(`${basePath}/tube/local/`, "local"),
      ...apps.map(a => dirResponse(`${basePath}/tube/local/${a}/`, a)),
    ];
    return { handled: true, responses };
  }

  // /fs/tube/local/<app>/
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

  // /fs/tube/local/<app>/<action>/
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

  // /fs/tube/s3/ — async, return a promise-like pattern
  if (url === `${basePath}/tube/s3`) {
    return { handled: true, async: true, fn: async () => {
      const apps = await s3ListApps();
      return [
        dirResponse(`${basePath}/tube/s3/`, "s3"),
        ...apps.map(a => dirResponse(`${basePath}/tube/s3/${a}/`, a)),
      ];
    }};
  }

  // /fs/tube/s3/<app>/
  const s3AppMatch = url.match(new RegExp(`^${basePath}/tube/s3/([^/]+)$`));
  if (s3AppMatch) {
    const app = s3AppMatch[1];
    return { handled: true, async: true, fn: async () => {
      const actions = await s3ListActions(app);
      return [
        dirResponse(`${basePath}/tube/s3/${app}/`, app),
        ...actions.map(a => dirResponse(`${basePath}/tube/s3/${app}/${a}/`, a)),
      ];
    }};
  }

  // /fs/tube/s3/<app>/<action>/
  const s3ActionMatch = url.match(new RegExp(`^${basePath}/tube/s3/([^/]+)/([^/]+)$`));
  if (s3ActionMatch) {
    const [, app, action] = s3ActionMatch;
    return { handled: true, async: true, fn: async () => {
      const files = await s3ListFiles(app, action);
      return [
        dirResponse(`${basePath}/tube/s3/${app}/${action}/`, action),
        ...files.map(r => fileResponse(
          `${basePath}/tube/s3/${app}/${action}/${r.name}`, r.name, r.size, r.modified, r.type
        )),
      ];
    }};
  }

  return { handled: false };
}

// --- GET ---

export async function get(url, basePath) {
  // /fs/tube/local/<app>/<action>/<file...>
  const localFileMatch = url.match(new RegExp(`^${basePath}/tube/local/([^/]+)/([^/]+)/(.+)$`));
  if (localFileMatch) {
    const [, app, action, filename] = localFileMatch;
    const content = localReadFile(app, action, filename);
    if (content === null) return { handled: true, notFound: true };
    const contentType = filename.endsWith(".json") || filename.endsWith(".request") ? "application/json" : "application/octet-stream";
    return { handled: true, content, contentType };
  }

  // /fs/tube/s3/<app>/<action>/<file...>
  const s3FileMatch = url.match(new RegExp(`^${basePath}/tube/s3/([^/]+)/([^/]+)/(.+)$`));
  if (s3FileMatch) {
    const [, app, action, filename] = s3FileMatch;
    const content = await s3ReadFile(app, action, filename);
    if (content === null) return { handled: true, notFound: true };
    const contentType = filename.endsWith(".json") ? "application/json" : "application/octet-stream";
    return { handled: true, content, contentType };
  }

  return { handled: false };
}

// --- POST (writes to local) ---

export function post(req, url, basePath) {
  const rawUrl = req.url;
  const urlPath = rawUrl.split("?")[0];
  // POST /fs/tube/<app>/<action> — writes to local
  const tubeMatch = urlPath.match(new RegExp(`^${basePath}/tube/(?:local/)?(.+)$`));
  if (!tubeMatch) return { handled: false };

  const tubePath = tubeMatch[1];
  // Don't allow POST to s3/ path
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
