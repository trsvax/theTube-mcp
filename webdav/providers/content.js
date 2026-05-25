import fs from "node:fs";
import path from "node:path";

const CONTENT_DIR = process.env.CONTENT_DIR || "/Users/bfb/github/theTube/theTube-content/content/posts";

// Reserved top-level names (not post types)
const RESERVED = ["logs", "aws", "tube"];

export function parseFrontmatter(filepath) {
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

export function getPosts() {
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

export function getTypes(posts) {
  return [...new Set(posts.map(p => p.type))];
}

export function propfind(url, basePath, { dirResponse, fileResponse }) {
  // /fs/<type>/
  const typeMatch = url.match(new RegExp(`^${basePath}/([^/]+)$`));
  if (typeMatch && !RESERVED.includes(typeMatch[1])) {
    const type = typeMatch[1];
    const posts = getPosts();
    const typePosts = posts.filter(p => p.type === type);
    const responses = [
      dirResponse(`${basePath}/${type}/`, type),
      ...typePosts.map(p => dirResponse(`${basePath}/${type}/${p.slug}/`, p.slug)),
    ];
    return { handled: true, responses };
  }

  // /fs/<type>/<slug>/
  const postMatch = url.match(new RegExp(`^${basePath}/([^/]+)/([^/]+)$`));
  if (postMatch && !RESERVED.includes(postMatch[1])) {
    const [, type, slug] = postMatch;
    const posts = getPosts();
    const post = posts.find(p => p.type === type && p.slug === slug);
    if (!post) return { handled: true, notFound: true };
    const filepath = path.join(CONTENT_DIR, post.filename);
    const stat = fs.statSync(filepath);
    const responses = [
      dirResponse(`${basePath}/${type}/${slug}/`, slug),
      fileResponse(`${basePath}/${type}/${slug}/post.md`, "post.md", stat.size, stat.mtime.toUTCString(), "text/markdown"),
    ];
    return { handled: true, responses };
  }

  return { handled: false };
}

export function get(url, basePath) {
  // /fs/<type>/<slug>/post.md
  const fileMatch = url.match(new RegExp(`^${basePath}/([^/]+)/([^/]+)/post\\.md$`));
  if (fileMatch) {
    const [, type, slug] = fileMatch;
    const posts = getPosts();
    const post = posts.find(p => p.type === type && p.slug === slug);
    if (!post) return { handled: true, notFound: true };
    const filepath = path.join(CONTENT_DIR, post.filename);
    const content = fs.readFileSync(filepath, "utf-8");
    return { handled: true, content, contentType: "text/markdown" };
  }

  return { handled: false };
}
