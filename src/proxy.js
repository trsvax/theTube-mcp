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
import { DatabaseSync as Database } from "node:sqlite";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

// Parse CLI args
const { values } = parseArgs({
  options: {
    server: { type: "string", default: "http://localhost:8080/fs" },
    db: {
      type: "string",
      default: resolve(import.meta.dirname, "../state.db"),
    },
    token: { type: "string", default: "" },
    logBucket: { type: "string", default: "thetube-today-logs" },
    logPrefix: { type: "string", default: "cf/" },
    distId: { type: "string", default: "E2DMNPNLN0VAQM" },
  },
});

const SERVER = values.server.replace(/\/$/, "");
const TOKEN = values.token;
const LOG_BUCKET = values.logBucket;
const LOG_PREFIX = values.logPrefix;
const DIST_ID = values.distId;
const s3 = new S3Client({});

// --- SQLite setup ---
const dbPath = values.db;
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");

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
  CREATE TABLE IF NOT EXISTS synced_logs (
    key TEXT PRIMARY KEY,
    synced_at INTEGER NOT NULL
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
  const headers = { Depth: "1" };
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
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_directory",
      description:
        "List contents of a virtual directory. The filesystem has: post types (journal/, post/, draft/), each containing post folders with post.md inside; and logs/ with dates containing hourly .tsv files.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Directory path (e.g. /, /journal, /logs, /logs/2026-05-23)",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "read_file",
      description:
        "Read a file from the virtual filesystem. Posts at /type/slug/post.md, logs at /logs/YYYY-MM-DD/HH.tsv (tab-separated CloudFront log entries).",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "File path (e.g. /journal/the-share-system/post.md or /logs/2026-05-23/22.tsv)",
          },
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
          pending: {
            type: "boolean",
            description: "Only show unpublished captures",
          },
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
          active_only: {
            type: "boolean",
            description: "Only show non-revoked, non-expired tokens",
          },
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
          limit: {
            type: "number",
            description: "Number of sessions to return (default 10)",
          },
        },
      },
    },
    {
      name: "sync_captures",
      description:
        "Read CloudFront logs from S3 for a given date, extract /tube/share/ entries, and store them in local SQLite. Deduplicates by file+date. Returns the new captures found.",
      inputSchema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Date to sync (YYYY-MM-DD). Defaults to today.",
          },
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
        const contents = entries.slice(1).map((e) => ({
          name: e.name,
          type: e.isDir ? "directory" : "file",
          href: e.href,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(contents, null, 2) }],
        };
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
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      }

      case "add_capture": {
        const stmt = db.prepare(
          "INSERT INTO captures (file, type, date, caption, logged_at) VALUES (?, ?, ?, ?, ?)",
        );
        stmt.run(
          args.file,
          args.type,
          args.date,
          args.caption || null,
          Math.floor(Date.now() / 1000),
        );
        return { content: [{ type: "text", text: "Capture recorded." }] };
      }

      case "list_tokens": {
        let sql = "SELECT * FROM tokens";
        if (args?.active_only) {
          const now = Math.floor(Date.now() / 1000);
          sql += ` WHERE revoked = 0 AND (expires_at > ${now} OR expires_at = 0)`;
        }
        const rows = db.prepare(sql).all();
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      }

      case "add_session_note": {
        const stmt = db.prepare(
          "INSERT INTO sessions (timestamp, summary) VALUES (?, ?)",
        );
        stmt.run(Math.floor(Date.now() / 1000), args.summary);
        return { content: [{ type: "text", text: "Session note recorded." }] };
      }

      case "recent_sessions": {
        const limit = args?.limit || 10;
        const rows = db
          .prepare("SELECT * FROM sessions ORDER BY timestamp DESC LIMIT ?")
          .all(limit);
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      }

      case "sync_captures": {
        const date = args?.date || new Date().toISOString().slice(0, 10);
        const prefix = `${LOG_PREFIX}${DIST_ID}.${date}-`;

        // List all log files for this date
        const listResp = await s3.send(
          new ListObjectsV2Command({
            Bucket: LOG_BUCKET,
            Prefix: prefix,
            MaxKeys: 1000,
          }),
        );

        const logFiles = listResp.Contents || [];
        const captures = [];
        let skipped = 0;

        const checkSynced = db.prepare(
          "SELECT key FROM synced_logs WHERE key = ?",
        );
        const markSynced = db.prepare(
          "INSERT INTO synced_logs (key, synced_at) VALUES (?, ?)",
        );
        const insertCapture = db.prepare(
          "INSERT INTO captures (file, type, date, caption, logged_at) VALUES (?, ?, ?, ?, ?)",
        );
        const checkCapture = db.prepare(
          "SELECT id FROM captures WHERE file = ? AND date = ?",
        );

        for (const obj of logFiles) {
          // Skip already-processed files
          if (checkSynced.get(obj.Key)) {
            skipped++;
            continue;
          }

          const getResp = await s3.send(
            new GetObjectCommand({ Bucket: LOG_BUCKET, Key: obj.Key }),
          );
          const buf = Buffer.from(await getResp.Body.transformToByteArray());
          const text = gunzipSync(buf).toString("utf-8");

          for (const line of text.split("\n")) {
            if (!line || line.startsWith("#")) continue;
            const fields = line.split("\t");
            const uri = fields[7]; // cs-uri-stem
            const qs = fields[11]; // cs-uri-query
            const status = fields[8]; // sc-status
            const logDate = fields[0]; // date
            const logTime = fields[1]; // time

            if (
              uri?.startsWith("/tube/share/") &&
              status === "202" &&
              qs &&
              qs !== "-"
            ) {
              const params = Object.fromEntries(
                qs.split("&").map((p) => {
                  const [k, ...v] = p.split("=");
                  return [
                    decodeURIComponent(k),
                    decodeURIComponent(v.join("=").replace(/\+/g, " ")),
                  ];
                }),
              );

              if (params.file) {
                captures.push({
                  file: params.file,
                  type: params.type || "unknown",
                  date: params.date || logDate,
                  caption: params.caption || null,
                  logged_at: Math.floor(
                    new Date(`${logDate}T${logTime}Z`).getTime() / 1000,
                  ),
                });
              }
            }
          }

          // Mark this log file as processed
          markSynced.run(obj.Key, Math.floor(Date.now() / 1000));
        }

        // Insert new captures (deduplicate by file+date)
        let added = 0;
        for (const c of captures) {
          if (!checkCapture.get(c.file, c.date)) {
            insertCapture.run(c.file, c.type, c.date, c.caption, c.logged_at);
            added++;
          }
        }

        const summary = `Scanned ${logFiles.length - skipped} new log files (${skipped} already synced) for ${date}. Found ${captures.length} share entries, added ${added} new captures.`;
        return {
          content: [
            {
              type: "text",
              text: summary + "\n\n" + JSON.stringify(captures, null, 2),
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// --- Start ---
const transport = new StdioServerTransport();
await server.connect(transport);
