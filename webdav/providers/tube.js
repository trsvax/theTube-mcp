import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Tube storage — local directory for dev, S3 prefix for production
const TUBE_DIR = process.env.TUBE_DIR || path.join(process.env.HOME || "/tmp", ".tube");

export function ensureTubeDir(...parts) {
  const dir = path.join(TUBE_DIR, ...parts);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function tubeListApps() {
  ensureTubeDir();
  return fs.readdirSync(TUBE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

export function tubeListActions(app) {
  const dir = path.join(TUBE_DIR, app);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

export function tubeListRequests(app, action) {
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

export function tubeReadFile(app, action, filename) {
  const filepath = path.join(TUBE_DIR, app, action, filename);
  if (!fs.existsSync(filepath)) return null;
  return fs.readFileSync(filepath, "utf-8");
}

export function tubeWriteRequest(app, action, requestId, metadata, body) {
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

export function propfind(url, basePath, { dirResponse, fileResponse }) {
  // /fs/tube/
  if (url === `${basePath}/tube`) {
    const apps = tubeListApps();
    const responses = [
      dirResponse(`${basePath}/tube/`, "tube"),
      ...apps.map(a => dirResponse(`${basePath}/tube/${a}/`, a)),
    ];
    return { handled: true, responses };
  }

  // /fs/tube/<app>/
  const tubeAppMatch = url.match(new RegExp(`^${basePath}/tube/([^/]+)$`));
  if (tubeAppMatch) {
    const app = tubeAppMatch[1];
    const actions = tubeListActions(app);
    const responses = [
      dirResponse(`${basePath}/tube/${app}/`, app),
      ...actions.map(a => dirResponse(`${basePath}/tube/${app}/${a}/`, a)),
    ];
    return { handled: true, responses };
  }

  // /fs/tube/<app>/<action>/
  const tubeActionMatch = url.match(new RegExp(`^${basePath}/tube/([^/]+)/([^/]+)$`));
  if (tubeActionMatch) {
    const [, app, action] = tubeActionMatch;
    const requests = tubeListRequests(app, action);
    const responses = [
      dirResponse(`${basePath}/tube/${app}/${action}/`, action),
      ...requests.map(r => fileResponse(
        `${basePath}/tube/${app}/${action}/${r.name}`, r.name, r.size, r.modified, r.type
      )),
    ];
    return { handled: true, responses };
  }

  return { handled: false };
}

export function get(url, basePath) {
  // /fs/tube/<app>/<action>/<file...>
  const tubeFileMatch = url.match(new RegExp(`^${basePath}/tube/([^/]+)/([^/]+)/(.+)$`));
  if (tubeFileMatch) {
    const [, app, action, filename] = tubeFileMatch;
    const content = tubeReadFile(app, action, filename);
    if (content === null) return { handled: true, notFound: true };
    const contentType = filename.endsWith(".json") ? "application/json" : "application/octet-stream";
    return { handled: true, content, contentType };
  }

  return { handled: false };
}

export function post(req, url, basePath) {
  const rawUrl = req.url;
  const urlPath = rawUrl.split("?")[0];
  const tubeMatch = urlPath.match(new RegExp(`^${basePath}/tube/(.+)$`));
  if (!tubeMatch) return { handled: false };

  const tubePath = tubeMatch[1];
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

        tubeWriteRequest(app, action, requestId, metadata, body.length > 0 ? body : null);

        const now = new Date();
        const yyyy = now.getUTCFullYear();
        const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(now.getUTCDate()).padStart(2, "0");
        const location = `${basePath}/tube/${app}/${action}/${yyyy}/${mm}/${dd}/${requestId}.request`;
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
