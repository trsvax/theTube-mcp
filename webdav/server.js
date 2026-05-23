import http from "node:http";
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
    const codeUrl = await getLambdaCodeUrl(name);
    if (!codeUrl) return [];
    const resp = await fetch(codeUrl);
    if (!resp.ok) return [];
    const buf = Buffer.from(await resp.arrayBuffer());
    return parseZip(buf);
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
const RESERVED = ["logs", "aws"];

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
