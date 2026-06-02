// S3 provider — routes through the tube
// No AWS credentials. Just tubeRequest.

import { tubeRequest } from "../../tubeRequest.js";

const S3_BUCKETS = (process.env.S3_BUCKETS || "thetube-today,thetube-today-logs").split(",");

export async function propfind(url, basePath, { dirResponse, fileResponse }) {
  if (url === `${basePath}/aws/s3`) {
    const responses = [
      dirResponse(`${basePath}/aws/s3/`, "s3"),
      fileResponse(`${basePath}/aws/s3/README.md`, "README.md", 0, null, "text/markdown"),
      ...S3_BUCKETS.map(b => dirResponse(`${basePath}/aws/s3/${b}/`, b)),
    ];
    return { handled: true, responses };
  }

  const bucketMatch = url.match(new RegExp(`^${basePath}/aws/s3/([^/]+)$`));
  if (bucketMatch) {
    const bucket = bucketMatch[1];
    if (!S3_BUCKETS.includes(bucket)) return { handled: false };
    return { handled: true, async: true, fn: async () => {
      const prefixes = await tubeRequest("aws/list-s3-prefixes", { bucket, prefix: "" });
      return [
        dirResponse(`${basePath}/aws/s3/${bucket}/`, bucket),
        ...(prefixes || []).map(p => dirResponse(`${basePath}/aws/s3/${bucket}/${p}/`, p)),
      ];
    }};
  }

  const prefixMatch = url.match(new RegExp(`^${basePath}/aws/s3/([^/]+)/(.+)$`));
  if (prefixMatch) {
    const [, bucket, subpath] = prefixMatch;
    if (!S3_BUCKETS.includes(bucket)) return { handled: false };
    const prefix = subpath + "/";
    return { handled: true, async: true, fn: async () => {
      const result = await tubeRequest("aws/list-s3-contents", { bucket, prefix });
      const dirs = result?.prefixes || [];
      const files = result?.files || [];
      return [
        dirResponse(`${basePath}/aws/s3/${bucket}/${subpath}/`, subpath.split("/").pop()),
        ...dirs.map(p => dirResponse(`${basePath}/aws/s3/${bucket}/${subpath}/${p}/`, p)),
        ...files.map(f => fileResponse(
          `${basePath}/aws/s3/${bucket}/${subpath}/${f.name}`, f.name, f.size, f.modified, "application/octet-stream"
        )),
      ];
    }};
  }

  return { handled: false };
}

export async function get(url, basePath) {
  if (url === `${basePath}/aws/s3/README.md`) {
    let md = `# S3 Buckets\n\n`;
    md += `| Bucket | Purpose |\n`;
    md += `|--------|---------|\n`;
    md += `| \`thetube-today\` | Site content, tube requests, static assets |\n`;
    md += `| \`thetube-today-logs\` | CloudFront access logs |\n`;
    md += `\nBrowse top-level prefixes in each bucket.\n`;
    return { handled: true, content: md, contentType: "text/markdown" };
  }

  return { handled: false };
}
