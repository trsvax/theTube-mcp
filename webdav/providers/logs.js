// logs provider — routes through the tube
// No AWS credentials. Just tubeRequest.

import { tubeRequest } from "../tubeRequest.js";

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

export async function propfind(url, basePath, { dirResponse, fileResponse }) {
  if (url === `${basePath}/logs`) {
    const dates = await tubeRequest("aws/list-log-dates");
    const responses = [
      dirResponse(`${basePath}/logs/`, "logs"),
      ...(dates || []).map(d => dirResponse(`${basePath}/logs/${d}/`, d)),
    ];
    return { handled: true, responses };
  }

  const logDateMatch = url.match(new RegExp(`^${basePath}/logs/(\\d{4}-\\d{2}-\\d{2})$`));
  if (logDateMatch) {
    const date = logDateMatch[1];
    const hours = await tubeRequest("aws/list-log-hours", { date });
    const responses = [
      dirResponse(`${basePath}/logs/${date}/`, date),
      ...(hours || []).map(h => fileResponse(
        `${basePath}/logs/${date}/${h}.tsv`, `${h}.tsv`, 0, null, "text/tab-separated-values"
      )),
    ];
    return { handled: true, responses };
  }

  return { handled: false };
}

export async function get(url, basePath) {
  const logFileMatch = url.match(new RegExp(`^${basePath}/logs/(\\d{4}-\\d{2}-\\d{2})/(\\d{2})\\.tsv$`));
  if (logFileMatch) {
    const [, date, hour] = logFileMatch;
    const content = await tubeRequest("aws/get-log-content", { date, hour });
    // Result is either a string or { content, contentType }
    const text = typeof content === "string" ? content : content?.content || "";
    return { handled: true, content: text, contentType: "text/tab-separated-values" };
  }

  return { handled: false };
}
