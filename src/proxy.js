#!/usr/bin/env node
/**
 * MCP Proxy — translates MCP tool calls to WebDAV reads + SQLite state.
 * 
 * The WebDAV server is the filesystem. This proxy is a thin translation layer.
 * 
 * Usage:
 *   node src/proxy.js --server http://localhost:8080/fs
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Database from "node:sqlite";
import { parseArgs } from "node:util";
import { resolve } from "node:path";

// Parse CLI args
const { values } = parseArgs({
  options: {
    server: { type: "string", default: "http://localhost:8080/fs" },
    db: { type: "string", default: resolve(import.meta.dirname, "../state.db") },
    token: { type: "string", default: "" },
  },
});

const SERVER = values.server.replace(/\/$/, "");
const TOKEN = values.token;

// --- SQLite setup ---
const dbPath = values.db;
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file TEXT NOT NULL,
    type TEXT NOT NULL,
    date TEXT NOT NULL,
    caption TEXT,
    logged_at INTEGER,
    published_at INTEGER,
    src TEXT
  );
  CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    device TEXT NOT NULL,
    scope TEXT NOT NULL,
    role TEXT,
    minted_at INTEGER,
    expires_at INTEGER,
    revoked INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    summary TEXT NOT NULL
  );
`);

// --- WebDAV helpers ---
async function webdavFetch(path, method = "GET") {
  const url = `${SERVER}${path}`;
  const headers = {};
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
  
  const res = await fetch(url, { method, headers });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
  return res.text();
}

async function propfind(path) {
  const url = `${SERVER}${path}`;
  const headers = { "Depth": "1" };
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
  
  const res = await fetch(url, { method: "PROPFIND", headers });
  if (!res.ok) throw new Error(`PROPFIND ${url} → ${res.status}`);
  const xml = await res.text();
  
  const entries = [];
  const responses = xml.split("<D:response>").slice(1);
  for (const r of responses) {
    const href = r.match(/<D:href>([^<]+)<\/D:href>/)?.[1] || "";
    const name = r.match(/<D:displayname>([^<]+)<\/D:displayname>/)?.[1] || "";
    const isDir = r.includes("<D:collection/>");
    entries.push({ href, name, isDir });
  }
  return entries;
}

// --- MCP Server ---
const server = new Server(
  { name: "thetube-proxy", version: "0.3.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_directory",
      description: "List contents of a virtual directory. The filesystem has: post types (journal/, post/, draft/), each containing post folders with post.md inside; and logs/ with dates containing hourly .tsv files.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (e.g. /, /journal, /logs, /logs/2026-05-23)" },
        },
        required: ["path"],
      },
    },
    {
      name: "read_file",
      description: "Read a file from the virtual filesystem. Posts at /type/slug/post.md, logs at /logs/YYYY-MM-DD/HH.tsv (tab-separated CloudFront log entries).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (e.g. /journal/the-share-system/post.md or /logs/2026-05-23/22.tsv)" },
        },
        required: ["path"],
      },
    },
    {
      name: "query_captures",
      description: "Query captures from local SQLite state",
      inputSchema: {
        type: "object",
        properties: {
          pending: { type: "boolean", description: "Only show unpublished captures" },
          date: { type: "string", description: "Filter by date (YYYY-MM-DD)" },
        },
      },
    },
    {
      name: "add_capture",
      description: "Record a capture in local state (called by share scripts)",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string" },
          type: { type: "string" },
          date: { type: "string" },
          caption: { type: "string" },
        },
        required: ["file", "type", "date"],
      },
    },
    {
      name: "list_tokens",
      description: "List active tokens from local state",
      inputSchema: {
        type: "object",
        properties: {
          active_only: { type: "boolean", description: "Only show non-revoked, non-expired tokens" },
        },
      },
    },
    {
      name: "add_session_note",
      description: "Record a session summary in local state",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Session summary text" },
        },
        required: ["summary"],
      },
    },
    {
      name: "recent_sessions",
      description: "Get recent session notes from local state",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of sessions to return (default 10)" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_directory": {
        const dirPath = args.path === "/" ? "/" : args.path.replace(/\/$/, "");
        const entries = await propfind(dirPath);
        const contents = entries.slice(1).map(e => ({
          name: e.name,
          type: e.isDir ? "directory" : "file",
          href: e.href,
        }));
        return { content: [{ type: "text", text: JSON.stringify(contents, null, 2) }] };
      }

      case "read_file": {
        const content = await webdavFetch(args.path);
        return { content: [{ type: "text", text: content }] };
      }

      case "query_captures": {
        let sql = "SELECT * FROM captures";
        const conditions = [];
        if (args?.pending) conditions.push("published_at IS NULL");
        if (args?.date) conditions.push(`date = '${args.date}'`);
        if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
        sql += " ORDER BY logged_at DESC LIMIT 50";
        const rows = db.prepare(sql).all();
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      }

      case "add_capture": {
        const stmt = db.prepare(
          "INSERT INTO captures (file, type, date, caption, logged_at) VALUES (?, ?, ?, ?, ?)"
        );
        stmt.run(args.file, args.type, args.date, args.caption || null, Math.floor(Date.now() / 1000));
        return { content: [{ type: "text", text: "Capture recorded." }] };
      }

      case "list_tokens": {
        let sql = "SELECT * FROM tokens";
        if (args?.active_only) {
          const now = Math.floor(Date.now() / 1000);
          sql += ` WHERE revoked = 0 AND (expires_at > ${now} OR expires_at = 0)`;
        }
        const rows = db.prepare(sql).all();
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      }

      case "add_session_note": {
        const stmt = db.prepare("INSERT INTO sessions (timestamp, summary) VALUES (?, ?)");
        stmt.run(Math.floor(Date.now() / 1000), args.summary);
        return { content: [{ type: "text", text: "Session note recorded." }] };
      }

      case "recent_sessions": {
        const limit = args?.limit || 10;
        const rows = db.prepare("SELECT * FROM sessions ORDER BY timestamp DESC LIMIT ?").all(limit);
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

// --- Start ---
const transport = new StdioServerTransport();
await server.connect(transport);
