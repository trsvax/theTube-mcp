import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { CloudFrontClient, GetDistributionConfigCommand } from "@aws-sdk/client-cloudfront";
import { LambdaClient, ListFunctionsCommand, GetFunctionConfigurationCommand, GetFunctionCommand } from "@aws-sdk/client-lambda";

// Config
const CONTENT_DIR = process.env.CONTENT_DIR || "/Users/bfb/github/theTube/theTube-content/content/posts";
const PORT = process.env.PORT || 8080;
const BASE_PATH = "/fs";
const LOG_BUCKET = process.env.LOG_BUCKET || "thetube-today-logs";
const LOG_PREFIX = process.env.LOG_PREFIX || "cf/";
const DIST_ID = process.env.DIST_ID || "E2DMNPNLN0VAQM";

const s3 = new S3Client({});
const cf = new CloudFrontClient({});
const lambda = new LambdaClient({});

// --- Cache ---
const cache = new Map();
const CACHE_TTL = 60_000;

function cached(key, fn) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.value;
  const promise = fn();
  promise.then(v => cache.set(key, { value: Promise.resolve(v), ts: Date.now() }));
  cache.set(key, { value: promise, ts: Date.now() });
  return promise;
}

// --- Content helpers ---

function parseFrontmatter(filepath) {
  const content = fs.readFileSync(filepath, "utf-8");
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  match[1].split("\n").forEach(line => {
    const [key, ...rest] = line.split(":");
    if (key && rest.length) fm[key.trim()] = rest.join(":").trim();
  });
  return fm;
}

function getPosts() {
  const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith(".md"));
  return files.map(f => {
    const fm = parseFrontmatter(path.join(CONTENT_DIR, f));
    return {
      slug: f.replace(".md", ""),
      title: fm.title || f,
      type: fm.type || "post",
      date: fm.date || "unknown",
      filename: f,
    };
  });
}

function getTypes(posts) {
  return [...new Set(posts.map(p => p.type))];
}

// --- Log helpers ---

const CF_FIELDS = [
  "date", "time", "x-edge-location", "sc-bytes", "c-ip", "cs-method",
  "cs-host", "cs-uri-stem", "sc-status", "cs-referer", "cs-user-agent",
  "cs-uri-query", "cs-cookie", "x-edge-result-type", "x-edge-request-id",
  "x-host-header", "cs-protocol", "cs-bytes", "time-taken", "x-forwarded-for",
  "ssl-protocol", "ssl-cipher", "x-edge-response-result-type", "cs-protocol-version",
  "fle-status", "fle-encrypted-fields", "c-port", "time-to-first-byte",
  "x-edge-detailed-result-type", "sc-content-type", "sc-content-len",
  "sc-range-start", "sc-range-end",
];

async function listLogDates() {
  const resp = await s3.send(new ListObjectsV2Command({
    Bucket: LOG_BUCKET,
    Prefix: LOG_PREFIX + DIST_ID,
    MaxKeys: 1000,
  }));
  const dates = new Set();
  for (const obj of resp.Contents || []) {
    const m = obj.Key.match(/\.(\d{4}-\d{2}-\d{2})-(\d{2})\./);
    if (m) dates.add(m[1]);
  }
  return [...dates].sort();
}

async function listLogHours(date) {
  const prefix = `${LOG_PREFIX}${DIST_ID}.${date}-`;
  const resp = await s3.send(new ListObjectsV2Command({
    Bucket: LOG_BUCKET,
    Prefix: prefix,
    MaxKeys: 1000,
  }));
  const hours = new Set();
  for (const obj of resp.Contents || []) {
    const m = obj.Key.match(/\.(\d{4}-\d{2}-\d{2})-(\d{2})\./);
    if (m) hours.add(m[2]);
  }
  return [...hours].sort();
}

async function getLogContent(date, hour) {
  const prefix = `${LOG_PREFIX}${DIST_ID}.${date}-${hour}.`;
  const resp = await s3.send(new ListObjectsV2Command({
    Bucket: LOG_BUCKET,
    Prefix: prefix,
    MaxKeys: 100,
  }));
  const lines = [CF_FIELDS.join("\t")];
  for (const obj of resp.Contents || []) {
    const getResp = await s3.send(new GetObjectCommand({ Bucket: LOG_BUCKET, Key: obj.Key }));
    const buf = Buffer.from(await getResp.Body.transformToByteArray());
    const text = gunzipSync(buf).toString("utf-8");
    for (const line of text.split("\n")) {
      if (line && !line.startsWith("#")) lines.push(line);
    }
  }
  return lines.join("\n");
}

// --- Tube helpers ---

function ensureTubeDir(...parts) {
  const dir = path.join(TUBE_DIR, ...parts);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tubeListApps() {
  ensureTubeDir();
  return fs.readdirSync(TUBE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function tubeListActions(app) {
  const dir = path.join(TUBE_DIR, app);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function tubeListRequests(app, action) {
  const dir = path.join(TUBE_DIR, app, action);
  if (!fs.existsSync(dir)) return [];
  // Recurse into YYYY/MM/DD subdirectories
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

function tubeReadFile(app, action, filename) {
  const filepath = path.join(TUBE_DIR, app, action, filename);
  if (!fs.existsSync(filepath)) return null;
  return fs.readFileSync(filepath, "utf-8");
}

function tubeWriteRequest(app, action, requestId, metadata, body) {
  // Write with YYYY/MM/DD date partition
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

// --- AWS helpers ---

async function getDistConfig() {
  return cached("cf-config", async () => {
    const resp = await cf.send(new GetDistributionConfigCommand({ Id: DIST_ID }));
    return resp.DistributionConfig;
  });
}

async function getLambdaFunctions() {
  return cached("lambda-list", async () => {
    const resp = await lambda.send(new ListFunctionsCommand({ MaxItems: 50 }));
    return (resp.Functions || []).filter(f => f.FunctionName.startsWith("thetube"));
  });
}

async function getLambdaConfig(name) {
  return cached(`lambda-cfg-${name}`, async () => {
    return lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
  });
}

async function getLambdaCodeUrl(name) {
  return cached(`lambda-code-${name}`, async () => {
    const resp = await lambda.send(new GetFunctionCommand({ FunctionName: name }));
    return resp.Code?.Location || null;
  });
}

// Minimal zip parser — uses central directory for reliable extraction
function parseZip(buf) {
  const files = [];
  // Find end of central directory record (scan from end)
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) return files;

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdEntries = buf.readUInt16LE(eocdOffset + 10);

  let offset = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf-8", offset + 46, offset + 46 + nameLen);

    // Read from local file header to get actual data offset
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let content;
    if (method === 0) content = raw;
    else if (method === 8) content = inflateRawSync(raw);
    else content = null;

    if (name && !name.endsWith("/")) {
      files.push({ name, content, size: uncompSize });
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function getLambdaFiles(name) {
  return cached(`lambda-files-${name}`, async () => {
    try {
      const codeUrl = await getLambdaCodeUrl(name);
      if (!codeUrl) return [];
      const resp = await fetch(codeUrl);
      if (!resp.ok) return [];
      const buf = Buffer.from(await resp.arrayBuffer());
      return parseZip(buf);
    } catch {
      return [];
    }
  });
}

// --- WebDAV XML ---

function multistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${responses.join("\n")}
</D:multistatus>`;
}

function dirResponse(href, displayname) {
  return `  <D:response>
    <D:href>${href}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${displayname}</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:getlastmodified>${new Date().toUTCString()}</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}

function fileResponse(href, displayname, size, modified, contentType) {
  return `  <D:response>
    <D:href>${href}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${displayname}</D:displayname>
        <D:resourcetype/>
        <D:getcontentlength>${size || 0}</D:getcontentlength>
        <D:getlastmodified>${modified || new Date().toUTCString()}</D:getlastmodified>
        <D:getcontenttype>${contentType || "application/json"}</D:getcontenttype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}

function json(res, obj) {
  const content = JSON.stringify(obj, null, 2);
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(content) });
  res.end(content);
}

function text(res, content, type) {
  res.writeHead(200, { "Content-Type": type, "Content-Length": Buffer.byteLength(content) });
  res.end(content);
}

// Reserved top-level names (not post types)
const RESERVED = ["logs", "aws", "tube"];

// Tube storage — local directory for dev, S3 prefix for production
const TUBE_DIR = process.env.TUBE_DIR || path.join(process.env.HOME || "/tmp", ".tube");

// --- Route handler ---

async function handleRequest(req, res) {
  const url = decodeURIComponent(req.url).replace(/\/$/, "") || BASE_PATH;
  const method = req.method.toUpperCase();

  console.log(`${method} ${url}`);

  if (method === "OPTIONS") {
    res.writeHead(200, { "DAV": "1", "Allow": "OPTIONS, PROPFIND, GET, HEAD", "Content-Length": "0" });
    res.end();
    return;
  }

  try {
    // Ignore macOS resource fork requests
    if (url.includes("/._")) {
      res.writeHead(404);
      res.end();
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PROPFIND
    // ═══════════════════════════════════════════════════════════════════════
    if (method === "PROPFIND") {

      // Root: /fs/
      if (url === BASE_PATH || url === `${BASE_PATH}/`) {
        const posts = getPosts();
        const types = getTypes(posts);
        const responses = [
          dirResponse(`${BASE_PATH}/`, "fs"),
          ...types.map(t => dirResponse(`${BASE_PATH}/${t}/`, t)),
          dirResponse(`${BASE_PATH}/logs/`, "logs"),
          dirResponse(`${BASE_PATH}/aws/`, "aws"),
          dirResponse(`${BASE_PATH}/tube/`, "tube"),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      // ── AWS ──────────────────────────────────────────────────────────────

      // /fs/aws/
      if (url === `${BASE_PATH}/aws`) {
        const responses = [
          dirResponse(`${BASE_PATH}/aws/`, "aws"),
          dirResponse(`${BASE_PATH}/aws/cloudfront/`, "cloudfront"),
          dirResponse(`${BASE_PATH}/aws/lambda/`, "lambda"),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      // /fs/aws/cloudfront/
      if (url === `${BASE_PATH}/aws/cloudfront`) {
        const responses = [
          dirResponse(`${BASE_PATH}/aws/cloudfront/`, "cloudfront"),
          fileResponse(`${BASE_PATH}/aws/cloudfront/README.md`, "README.md", 0, null, "text/markdown"),
          fileResponse(`${BASE_PATH}/aws/cloudfront/general.json`, "general.json"),
          dirResponse(`${BASE_PATH}/aws/cloudfront/origins/`, "origins"),
          dirResponse(`${BASE_PATH}/aws/cloudfront/behaviors/`, "behaviors"),
          fileResponse(`${BASE_PATH}/aws/cloudfront/error-pages.json`, "error-pages.json"),
          fileResponse(`${BASE_PATH}/aws/cloudfront/logging.json`, "logging.json"),
          fileResponse(`${BASE_PATH}/aws/cloudfront/tags.json`, "tags.json"),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      // /fs/aws/cloudfront/origins/
      if (url === `${BASE_PATH}/aws/cloudfront/origins`) {
        const config = await getDistConfig();
        const origins = config.Origins?.Items || [];
        const responses = [
          dirResponse(`${BASE_PATH}/aws/cloudfront/origins/`, "origins"),
          ...origins.map(o => fileResponse(
            `${BASE_PATH}/aws/cloudfront/origins/${o.Id}.json`, `${o.Id}.json`
          )),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      // /fs/aws/cloudfront/behaviors/
      if (url === `${BASE_PATH}/aws/cloudfront/behaviors`) {
        const config = await getDistConfig();
        const behaviors = config.CacheBehaviors?.Items || [];
        const responses = [
          dirResponse(`${BASE_PATH}/aws/cloudfront/behaviors/`, "behaviors"),
          fileResponse(`${BASE_PATH}/aws/cloudfront/behaviors/default.json`, "default.json"),
          ...behaviors.map((b, i) => {
            const name = `${i}-${b.PathPattern.replace(/[/*]/g, "").replace(/\s/g, "-") || "path"}`;
            return fileResponse(`${BASE_PATH}/aws/cloudfront/behaviors/${name}.json`, `${name}.json`);
          }),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      // /fs/aws/lambda/
      if (url === `${BASE_PATH}/aws/lambda`) {
        const fns = await getLambdaFunctions();
        const responses = [
          dirResponse(`${BASE_PATH}/aws/lambda/`, "lambda"),
          fileResponse(`${BASE_PATH}/aws/lambda/README.md`, "README.md", 0, null, "text/markdown"),
          ...fns.map(f => dirResponse(`${BASE_PATH}/aws/lambda/${f.FunctionName}/`, f.FunctionName)),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      // /fs/aws/lambda/<name>/
      const lambdaDirMatch = url.match(new RegExp(`^${BASE_PATH}/aws/lambda/([^/]+)$`));
      if (lambdaDirMatch) {
        const name = lambdaDirMatch[1];
        if (name.startsWith("._") || name === "README.md") { res.writeHead(404); res.end(); return; }
        const files = await getLambdaFiles(name);
        const responses = [
          dirResponse(`${BASE_PATH}/aws/lambda/${name}/`, name),
          fileResponse(`${BASE_PATH}/aws/lambda/${name}/config.json`, "config.json"),
          fileResponse(`${BASE_PATH}/aws/lambda/${name}/env.json`, "env.json"),
          ...files.map(f => fileResponse(
            `${BASE_PATH}/aws/lambda/${name}/${f.name}`, f.name, f.size, null,
            f.name.endsWith(".js") ? "text/javascript" : "application/octet-stream"
          )),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      // ── Tube ──────────────────────────────────────────────────────────

      // /fs/tube/
      if (url === `${BASE_PATH}/tube`) {
        // List app directories (share/, comments/, react/, etc.)
        const apps = tubeListApps();
        const responses = [
          dirResponse(`${BASE_PATH}/tube/`, "tube"),
          ...apps.map(a => dirResponse(`${BASE_PATH}/tube/${a}/`, a)),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      // /fs/tube/<app>/
      const tubeAppMatch = url.match(new RegExp(`^${BASE_PATH}/tube/([^/]+)$`));
      if (tubeAppMatch) {
        const app = tubeAppMatch[1];
        const actions = tubeListActions(app);
        const responses = [
          dirResponse(`${BASE_PATH}/tube/${app}/`, app),
          ...actions.map(a => dirResponse(`${BASE_PATH}/tube/${app}/${a}/`, a)),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      // /fs/tube/<app>/<action>/
      const tubeActionMatch = url.match(new RegExp(`^${BASE_PATH}/tube/([^/]+)/([^/]+)$`));
      if (tubeActionMatch) {
        const [, app, action] = tubeActionMatch;
        const requests = tubeListRequests(app, action);
        const responses = [
          dirResponse(`${BASE_PATH}/tube/${app}/${action}/`, action),
          ...requests.map(r => fileResponse(
            `${BASE_PATH}/tube/${app}/${action}/${r.name}`, r.name, r.size, r.modified, r.type
          )),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      // ── Logs ─────────────────────────────────────────────────────────────

      if (url === `${BASE_PATH}/logs`) {
        const dates = await listLogDates();
        const responses = [
          dirResponse(`${BASE_PATH}/logs/`, "logs"),
          ...dates.map(d => dirResponse(`${BASE_PATH}/logs/${d}/`, d)),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      const logDateMatch = url.match(new RegExp(`^${BASE_PATH}/logs/(\\d{4}-\\d{2}-\\d{2})$`));
      if (logDateMatch) {
        const date = logDateMatch[1];
        const hours = await listLogHours(date);
        const responses = [
          dirResponse(`${BASE_PATH}/logs/${date}/`, date),
          ...hours.map(h => fileResponse(
            `${BASE_PATH}/logs/${date}/${h}.tsv`, `${h}.tsv`, 0, null, "text/tab-separated-values"
          )),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      // ── Content ──────────────────────────────────────────────────────────

      const typeMatch = url.match(new RegExp(`^${BASE_PATH}/([^/]+)$`));
      if (typeMatch && !RESERVED.includes(typeMatch[1])) {
        const type = typeMatch[1];
        const posts = getPosts();
        const typePosts = posts.filter(p => p.type === type);
        const responses = [
          dirResponse(`${BASE_PATH}/${type}/`, type),
          ...typePosts.map(p => dirResponse(`${BASE_PATH}/${type}/${p.slug}/`, p.slug)),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      const postMatch = url.match(new RegExp(`^${BASE_PATH}/([^/]+)/([^/]+)$`));
      if (postMatch && !RESERVED.includes(postMatch[1])) {
        const [, type, slug] = postMatch;
        const posts = getPosts();
        const post = posts.find(p => p.type === type && p.slug === slug);
        if (!post) { res.writeHead(404); res.end(); return; }
        const filepath = path.join(CONTENT_DIR, post.filename);
        const stat = fs.statSync(filepath);
        const responses = [
          dirResponse(`${BASE_PATH}/${type}/${slug}/`, slug),
          fileResponse(`${BASE_PATH}/${type}/${slug}/post.md`, "post.md", stat.size, stat.mtime.toUTCString(), "text/markdown"),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      res.writeHead(404);
      res.end();
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // GET / HEAD
    // ═══════════════════════════════════════════════════════════════════════
    if (method === "GET" || method === "HEAD") {

      // ── AWS CloudFront GET ───────────────────────────────────────────────

      if (url === `${BASE_PATH}/aws/cloudfront/general.json`) {
        const config = await getDistConfig();
        return json(res, {
          id: DIST_ID,
          comment: config.Comment,
          enabled: config.Enabled,
          aliases: config.Aliases?.Items || [],
          defaultRootObject: config.DefaultRootObject,
          priceClass: config.PriceClass,
          httpVersion: config.HttpVersion,
          ipv6: config.IsIPV6Enabled,
          certificate: config.ViewerCertificate?.ACMCertificateArn || null,
          sslMethod: config.ViewerCertificate?.SSLSupportMethod || null,
        });
      }

      // /fs/aws/cloudfront/README.md — generated from live config
      if (url === `${BASE_PATH}/aws/cloudfront/README.md`) {
        const config = await getDistConfig();
        const behaviors = config.CacheBehaviors?.Items || [];
        const defaultB = config.DefaultCacheBehavior;

        let md = `# CloudFront: ${config.Comment || DIST_ID}\n\n`;
        md += `Distribution \`${DIST_ID}\` — \`${(config.Aliases?.Items || []).join(", ")}\`\n\n`;
        md += `## Behaviors\n\n`;
        md += `| # | Path | Function | Methods |\n`;
        md += `|---|------|----------|---------|\n`;

        for (let i = 0; i < behaviors.length; i++) {
          const b = behaviors[i];
          const fn = (b.FunctionAssociations?.Items || []).map(f => f.FunctionARN.split("/").pop()).join(", ")
            || (b.LambdaFunctionAssociations?.Items || []).map(l => l.LambdaFunctionARN.split(":function:").pop()).join(", ")
            || "—";
          md += `| ${i} | \`${b.PathPattern}\` | ${fn} | ${(b.AllowedMethods?.Items || []).join(", ")} |\n`;
        }

        const defaultFn = (defaultB.FunctionAssociations?.Items || []).map(f => f.FunctionARN.split("/").pop()).join(", ") || "—";
        md += `| — | \`*\` (default) | ${defaultFn} | ${(defaultB.AllowedMethods?.Items || []).join(", ")} |\n`;

        md += `\n## Logging\n\n`;
        md += `- Bucket: \`${config.Logging?.Bucket || "disabled"}\`\n`;
        md += `- Prefix: \`${config.Logging?.Prefix || ""}\`\n`;
        md += `- Cookies: ${config.Logging?.IncludeCookies ? "yes" : "no"}\n`;

        md += `\n## General\n\n`;
        md += `- HTTP: ${config.HttpVersion}\n`;
        md += `- IPv6: ${config.IsIPV6Enabled ? "yes" : "no"}\n`;
        md += `- Price class: ${config.PriceClass}\n`;
        md += `- SSL: ${config.ViewerCertificate?.SSLSupportMethod || "default"}\n`;

        return text(res, md, "text/markdown");
      }

      if (url === `${BASE_PATH}/aws/cloudfront/error-pages.json`) {
        const config = await getDistConfig();
        const pages = (config.CustomErrorResponses?.Items || []).map(e => ({
          errorCode: e.ErrorCode,
          responseCode: e.ResponseCode,
          responsePage: e.ResponsePagePath,
          ttl: e.ErrorCachingMinTTL,
        }));
        return json(res, pages);
      }

      if (url === `${BASE_PATH}/aws/cloudfront/logging.json`) {
        const config = await getDistConfig();
        return json(res, {
          enabled: config.Logging?.Enabled || false,
          bucket: config.Logging?.Bucket || null,
          prefix: config.Logging?.Prefix || null,
          includeCookies: config.Logging?.IncludeCookies || false,
        });
      }

      if (url === `${BASE_PATH}/aws/cloudfront/tags.json`) {
        return json(res, {});
      }

      // /fs/aws/cloudfront/origins/<id>.json
      const originMatch = url.match(new RegExp(`^${BASE_PATH}/aws/cloudfront/origins/([^/]+)\\.json$`));
      if (originMatch) {
        const id = originMatch[1];
        const config = await getDistConfig();
        const origin = (config.Origins?.Items || []).find(o => o.Id === id);
        if (!origin) { res.writeHead(404); res.end(); return; }
        return json(res, {
          id: origin.Id,
          domain: origin.DomainName,
          path: origin.OriginPath || "/",
          protocol: origin.CustomOriginConfig?.OriginProtocolPolicy || "https-only",
          s3Config: origin.S3OriginConfig || null,
          originAccessControl: origin.OriginAccessControlId || null,
        });
      }

      // /fs/aws/cloudfront/behaviors/default.json
      if (url === `${BASE_PATH}/aws/cloudfront/behaviors/default.json`) {
        const config = await getDistConfig();
        const b = config.DefaultCacheBehavior;
        return json(res, formatBehavior(b, "*"));
      }

      // /fs/aws/cloudfront/behaviors/<n>-<name>.json
      const behaviorMatch = url.match(new RegExp(`^${BASE_PATH}/aws/cloudfront/behaviors/(\\d+)-([^/]+)\\.json$`));
      if (behaviorMatch) {
        const idx = parseInt(behaviorMatch[1]);
        const config = await getDistConfig();
        const b = config.CacheBehaviors?.Items?.[idx];
        if (!b) { res.writeHead(404); res.end(); return; }
        return json(res, formatBehavior(b, b.PathPattern));
      }

      // ── AWS Lambda GET ───────────────────────────────────────────────────

      // /fs/aws/lambda/README.md — generated from live config
      if (url === `${BASE_PATH}/aws/lambda/README.md`) {
        const fns = await getLambdaFunctions();
        let md = `# Lambda Functions\n\n`;
        md += `Functions matching \`thetube-*\`.\n\n`;
        md += `| Function | Runtime | Memory | Timeout | Last Modified |\n`;
        md += `|----------|---------|--------|---------|---------------|\n`;
        for (const f of fns) {
          md += `| \`${f.FunctionName}\` | ${f.Runtime} | ${f.MemorySize}MB | ${f.Timeout}s | ${f.LastModified?.split("T")[0] || "—"} |\n`;
        }
        md += `\n## Details\n\n`;
        md += `Each function directory contains:\n`;
        md += `- \`config.json\` — runtime, handler, memory, timeout, role\n`;
        md += `- \`env.json\` — environment variables\n`;
        md += `- Source files extracted from the deployment package\n`;
        return text(res, md, "text/markdown");
      }

      // /fs/aws/lambda/<name>/config.json
      const lambdaConfigMatch = url.match(new RegExp(`^${BASE_PATH}/aws/lambda/([^/]+)/config\\.json$`));
      if (lambdaConfigMatch) {
        const name = lambdaConfigMatch[1];
        const cfg = await getLambdaConfig(name);
        return json(res, {
          name: cfg.FunctionName,
          runtime: cfg.Runtime,
          handler: cfg.Handler,
          memory: cfg.MemorySize,
          timeout: cfg.Timeout,
          lastModified: cfg.LastModified,
          codeSize: cfg.CodeSize,
          arn: cfg.FunctionArn,
          role: cfg.Role,
          layers: (cfg.Layers || []).map(l => l.Arn),
        });
      }

      // /fs/aws/lambda/<name>/env.json
      const lambdaEnvMatch = url.match(new RegExp(`^${BASE_PATH}/aws/lambda/([^/]+)/env\\.json$`));
      if (lambdaEnvMatch) {
        const name = lambdaEnvMatch[1];
        const cfg = await getLambdaConfig(name);
        return json(res, cfg.Environment?.Variables || {});
      }

      // /fs/aws/lambda/<name>/<file> (code files from deployment package)
      const lambdaCodeMatch = url.match(new RegExp(`^${BASE_PATH}/aws/lambda/([^/]+)/(.+)$`));
      if (lambdaCodeMatch) {
        const [, name, filename] = lambdaCodeMatch;
        if (filename === "config.json" || filename === "env.json") {
          // handled above — fall through shouldn't happen, but just in case
          res.writeHead(404); res.end(); return;
        }
        const files = await getLambdaFiles(name);
        const file = files.find(f => f.name === filename);
        if (!file || !file.content) { res.writeHead(404); res.end(); return; }
        const contentType = filename.endsWith(".js") ? "text/javascript"
          : filename.endsWith(".json") ? "application/json"
          : filename.endsWith(".mjs") ? "text/javascript"
          : "text/plain";
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": file.content.length,
        });
        if (method === "GET") res.end(file.content);
        else res.end();
        return;
      }

      // ── Logs GET ─────────────────────────────────────────────────────────

      const logFileMatch = url.match(new RegExp(`^${BASE_PATH}/logs/(\\d{4}-\\d{2}-\\d{2})/(\\d{2})\\.tsv$`));
      if (logFileMatch) {
        const [, date, hour] = logFileMatch;
        const content = await getLogContent(date, hour);
        return text(res, content, "text/tab-separated-values");
      }

      // ── Tube GET ────────────────────────────────────────────────────────

      const tubeFileMatch = url.match(new RegExp(`^${BASE_PATH}/tube/([^/]+)/([^/]+)/(.+)$`));
      if (tubeFileMatch) {
        const [, app, action, filename] = tubeFileMatch;
        const content = tubeReadFile(app, action, filename);
        if (content === null) { res.writeHead(404); res.end(); return; }
        const contentType = filename.endsWith(".json") ? "application/json" : "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": Buffer.byteLength(content),
        });
        if (method === "GET") res.end(content);
        else res.end();
        return;
      }

      // ── Content GET ──────────────────────────────────────────────────────

      const fileMatch = url.match(new RegExp(`^${BASE_PATH}/([^/]+)/([^/]+)/post\\.md$`));
      if (fileMatch) {
        const [, type, slug] = fileMatch;
        const posts = getPosts();
        const post = posts.find(p => p.type === type && p.slug === slug);
        if (!post) { res.writeHead(404); res.end(); return; }
        const filepath = path.join(CONTENT_DIR, post.filename);
        const content = fs.readFileSync(filepath, "utf-8");
        return text(res, content, "text/markdown");
      }

      res.writeHead(404);
      res.end();
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // POST — the tube (local cat Lambda)
    // ═══════════════════════════════════════════════════════════════════════
    if (method === "POST") {
      const rawUrl = req.url;
      const urlPath = rawUrl.split("?")[0];
      const tubeMatch = urlPath.match(new RegExp(`^${BASE_PATH}/tube/(.+)$`));
      if (!tubeMatch) { res.writeHead(404); res.end(); return; }

      const tubePath = tubeMatch[1]; // e.g. "share/add"
      const parts = tubePath.split("/");
      const app = parts[0];
      const action = parts.slice(1).join("/") || "default";
      const requestId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

      // Collect body
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
        const location = `${BASE_PATH}/tube/${app}/${action}/${yyyy}/${mm}/${dd}/${requestId}.request`;
        res.writeHead(202, {
          "Content-Type": "application/json",
          "Location": location,
          "X-Request-Id": requestId,
        });
        res.end(JSON.stringify({ status: "Noted", requestId, location }));
      });
      return;
    }

    res.writeHead(405);
    res.end();
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end(err.message);
  }
}

// Format a CloudFront behavior for display
function formatBehavior(b, pathPattern) {
  return {
    path: pathPattern,
    origin: b.TargetOriginId,
    viewerProtocol: b.ViewerProtocolPolicy,
    allowedMethods: b.AllowedMethods?.Items || [],
    cachedMethods: b.AllowedMethods?.CachedMethods?.Items || [],
    compress: b.Compress || false,
    cachePolicyId: b.CachePolicyId || null,
    originRequestPolicyId: b.OriginRequestPolicyId || null,
    lambdaAssociations: (b.LambdaFunctionAssociations?.Items || []).map(l => ({
      event: l.EventType,
      arn: l.LambdaFunctionARN,
    })),
    functionAssociations: (b.FunctionAssociations?.Items || []).map(f => ({
      event: f.EventType,
      arn: f.FunctionARN,
    })),
  };
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`WebDAV server running on http://localhost:${PORT}${BASE_PATH}/`);
  console.log(`Content from: ${CONTENT_DIR}`);
  console.log(`Logs from: s3://${LOG_BUCKET}/${LOG_PREFIX}`);
  console.log(`AWS: CloudFront ${DIST_ID}, Lambda (thetube-*)`);
  console.log("");
  console.log("Mount with:");
  console.log(`  mkdir -p /tmp/tube && mount -t webdav http://localhost:${PORT}${BASE_PATH}/ /tmp/tube`);
});
