import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// Content source — reads posts from the local repo
const CONTENT_DIR = process.env.CONTENT_DIR || "/Users/bfb/github/theTube/theTube-content/content/posts";
const PORT = process.env.PORT || 8080;
const BASE_PATH = "/fs";

// Parse frontmatter from a markdown file
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

// Get all posts grouped by type
function getPosts() {
  const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith(".md"));
  const posts = files.map(f => {
    const fm = parseFrontmatter(path.join(CONTENT_DIR, f));
    return {
      slug: f.replace(".md", ""),
      title: fm.title || f,
      type: fm.type || "post",
      date: fm.date || "unknown",
      filename: f,
    };
  });
  return posts;
}

// Get unique types
function getTypes(posts) {
  return [...new Set(posts.map(p => p.type))];
}

// WebDAV XML helpers
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

function fileResponse(href, displayname, size, modified) {
  return `  <D:response>
    <D:href>${href}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${displayname}</D:displayname>
        <D:resourcetype/>
        <D:getcontentlength>${size}</D:getcontentlength>
        <D:getlastmodified>${modified || new Date().toUTCString()}</D:getlastmodified>
        <D:getcontenttype>text/markdown</D:getcontenttype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}

// Route handler
function handleRequest(req, res) {
  const url = decodeURIComponent(req.url).replace(/\/$/, "") || BASE_PATH;
  const method = req.method.toUpperCase();
  const posts = getPosts();

  console.log(`${method} ${url}`);

  // OPTIONS — required for WebDAV discovery
  if (method === "OPTIONS") {
    res.writeHead(200, {
      "DAV": "1",
      "Allow": "OPTIONS, PROPFIND, GET, HEAD",
      "Content-Length": "0",
    });
    res.end();
    return;
  }

  // PROPFIND — directory listings
  if (method === "PROPFIND") {
    // Root: /fs/
    if (url === BASE_PATH || url === `${BASE_PATH}/`) {
      const types = getTypes(posts);
      const responses = [
        dirResponse(`${BASE_PATH}/`, "fs"),
        ...types.map(t => dirResponse(`${BASE_PATH}/${t}/`, t)),
      ];
      res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
      res.end(multistatus(responses));
      return;
    }

    // Type directory: /fs/journal/
    const typeMatch = url.match(new RegExp(`^${BASE_PATH}/([^/]+)$`));
    if (typeMatch) {
      const type = typeMatch[1];
      const typePosts = posts.filter(p => p.type === type);
      const responses = [
        dirResponse(`${BASE_PATH}/${type}/`, type),
        ...typePosts.map(p => dirResponse(`${BASE_PATH}/${type}/${p.slug}/`, p.slug)),
      ];
      res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
      res.end(multistatus(responses));
      return;
    }

    // Post directory: /fs/journal/the-share-system/
    const postMatch = url.match(new RegExp(`^${BASE_PATH}/([^/]+)/([^/]+)$`));
    if (postMatch) {
      const [, type, slug] = postMatch;
      const post = posts.find(p => p.type === type && p.slug === slug);
      if (!post) { res.writeHead(404); res.end(); return; }
      const filepath = path.join(CONTENT_DIR, post.filename);
      const stat = fs.statSync(filepath);
      const responses = [
        dirResponse(`${BASE_PATH}/${type}/${slug}/`, slug),
        fileResponse(`${BASE_PATH}/${type}/${slug}/post.md`, "post.md", stat.size, stat.mtime.toUTCString()),
      ];
      res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
      res.end(multistatus(responses));
      return;
    }

    res.writeHead(404);
    res.end();
    return;
  }

  // GET — file content
  if (method === "GET" || method === "HEAD") {
    const fileMatch = url.match(new RegExp(`^${BASE_PATH}/([^/]+)/([^/]+)/post\\.md$`));
    if (fileMatch) {
      const [, type, slug] = fileMatch;
      const post = posts.find(p => p.type === type && p.slug === slug);
      if (!post) { res.writeHead(404); res.end(); return; }
      const filepath = path.join(CONTENT_DIR, post.filename);
      const content = fs.readFileSync(filepath, "utf-8");
      res.writeHead(200, {
        "Content-Type": "text/markdown",
        "Content-Length": Buffer.byteLength(content),
      });
      if (method === "GET") res.end(content);
      else res.end();
      return;
    }

    res.writeHead(404);
    res.end();
    return;
  }

  res.writeHead(405);
  res.end();
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`WebDAV server running on http://localhost:${PORT}${BASE_PATH}/`);
  console.log(`Content from: ${CONTENT_DIR}`);
  console.log("");
  console.log("Mount with:");
  console.log(`  mkdir -p /tmp/tube && mount -t webdav http://localhost:${PORT}${BASE_PATH}/ /tmp/tube`);
  console.log("");
  console.log("Or in Finder: Go → Connect to Server → http://localhost:${PORT}${BASE_PATH}/");
});
