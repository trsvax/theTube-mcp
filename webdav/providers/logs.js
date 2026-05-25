import { gunzipSync } from "node:zlib";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { cached } from "../cache.js";

const LOG_BUCKET = process.env.LOG_BUCKET || "thetube-today-logs";
const LOG_PREFIX = process.env.LOG_PREFIX || "cf/";
const DIST_ID = process.env.DIST_ID || "E2DMNPNLN0VAQM";

const s3 = new S3Client({});

export const CF_FIELDS = [
  "date", "time", "x-edge-location", "sc-bytes", "c-ip", "cs-method",
  "cs-host", "cs-uri-stem", "sc-status", "cs-referer", "cs-user-agent",
  "cs-uri-query", "cs-cookie", "x-edge-result-type", "x-edge-request-id",
  "x-host-header", "cs-protocol", "cs-bytes", "time-taken", "x-forwarded-for",
  "ssl-protocol", "ssl-cipher", "x-edge-response-result-type", "cs-protocol-version",
  "fle-status", "fle-encrypted-fields", "c-port", "time-to-first-byte",
  "x-edge-detailed-result-type", "sc-content-type", "sc-content-len",
  "sc-range-start", "sc-range-end",
];

export async function listLogDates() {
  return cached("log-dates", async () => {
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
  });
}

export async function listLogHours(date) {
  return cached(`log-hours-${date}`, async () => {
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
  });
}

export async function getLogContent(date, hour) {
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

export async function propfind(url, basePath, { dirResponse, fileResponse }) {
  // /fs/logs/
  if (url === `${basePath}/logs`) {
    const dates = await listLogDates();
    const responses = [
      dirResponse(`${basePath}/logs/`, "logs"),
      ...dates.map(d => dirResponse(`${basePath}/logs/${d}/`, d)),
    ];
    return { handled: true, responses };
  }

  // /fs/logs/<date>/
  const logDateMatch = url.match(new RegExp(`^${basePath}/logs/(\\d{4}-\\d{2}-\\d{2})$`));
  if (logDateMatch) {
    const date = logDateMatch[1];
    const hours = await listLogHours(date);
    const responses = [
      dirResponse(`${basePath}/logs/${date}/`, date),
      ...hours.map(h => fileResponse(
        `${basePath}/logs/${date}/${h}.tsv`, `${h}.tsv`, 0, null, "text/tab-separated-values"
      )),
    ];
    return { handled: true, responses };
  }

  return { handled: false };
}

export async function get(url, basePath) {
  // /fs/logs/<date>/<hour>.tsv
  const logFileMatch = url.match(new RegExp(`^${basePath}/logs/(\\d{4}-\\d{2}-\\d{2})/(\\d{2})\\.tsv$`));
  if (logFileMatch) {
    const [, date, hour] = logFileMatch;
    const content = await getLogContent(date, hour);
    return { handled: true, content, contentType: "text/tab-separated-values" };
  }

  return { handled: false };
}
