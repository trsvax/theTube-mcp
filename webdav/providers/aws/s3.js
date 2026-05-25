// S3 buckets provider — shows thetube buckets and top-level prefixes
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { cached } from "../../cache.js";

const S3_BUCKETS = (process.env.S3_BUCKETS || "thetube-today,thetube-today-logs").split(",");
const s3 = new S3Client({});

async function listPrefixes(bucket, prefix = "") {
  return cached(`s3-prefixes-${bucket}-${prefix}`, async () => {
    try {
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, Delimiter: "/", MaxKeys: 100,
      }));
      return (resp.CommonPrefixes || []).map(p => p.Prefix.replace(prefix, "").replace(/\/$/, ""));
    } catch { return []; }
  });
}

export async function propfind(url, basePath, { dirResponse, fileResponse }) {
  // /fs/aws/s3/
  if (url === `${basePath}/aws/s3`) {
    const responses = [
      dirResponse(`${basePath}/aws/s3/`, "s3"),
      fileResponse(`${basePath}/aws/s3/README.md`, "README.md", 0, null, "text/markdown"),
      ...S3_BUCKETS.map(b => dirResponse(`${basePath}/aws/s3/${b}/`, b)),
    ];
    return { handled: true, responses };
  }

  // /fs/aws/s3/<bucket>/
  const bucketMatch = url.match(new RegExp(`^${basePath}/aws/s3/([^/]+)$`));
  if (bucketMatch) {
    const bucket = bucketMatch[1];
    if (!S3_BUCKETS.includes(bucket)) return { handled: false };
    return { handled: true, async: true, fn: async () => {
      const prefixes = await listPrefixes(bucket);
      return [
        dirResponse(`${basePath}/aws/s3/${bucket}/`, bucket),
        ...prefixes.map(p => dirResponse(`${basePath}/aws/s3/${bucket}/${p}/`, p)),
      ];
    }};
  }

  // /fs/aws/s3/<bucket>/<prefix>/
  const prefixMatch = url.match(new RegExp(`^${basePath}/aws/s3/([^/]+)/(.+)$`));
  if (prefixMatch) {
    const [, bucket, subpath] = prefixMatch;
    if (!S3_BUCKETS.includes(bucket)) return { handled: false };
    const prefix = subpath + "/";
    return { handled: true, async: true, fn: async () => {
      const prefixes = await listPrefixes(bucket, prefix);
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, Delimiter: "/", MaxKeys: 100,
      }));
      const files = (resp.Contents || [])
        .filter(obj => obj.Key !== prefix)
        .map(obj => ({
          name: obj.Key.replace(prefix, ""),
          size: obj.Size,
          modified: obj.LastModified?.toUTCString() || "",
        }));
      return [
        dirResponse(`${basePath}/aws/s3/${bucket}/${subpath}/`, subpath.split("/").pop()),
        ...prefixes.map(p => dirResponse(`${basePath}/aws/s3/${bucket}/${subpath}/${p}/`, p)),
        ...files.map(f => fileResponse(
          `${basePath}/aws/s3/${bucket}/${subpath}/${f.name}`, f.name, f.size, f.modified, "application/octet-stream"
        )),
      ];
    }};
  }

  return { handled: false };
}

export async function get(url, basePath) {
  // /fs/aws/s3/README.md
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
