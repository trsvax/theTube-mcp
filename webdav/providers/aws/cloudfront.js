import { CloudFrontClient, GetDistributionConfigCommand } from "@aws-sdk/client-cloudfront";
import { cached } from "../../cache.js";

const DIST_ID = process.env.DIST_ID || "E2DMNPNLN0VAQM";

const cf = new CloudFrontClient({});

async function getDistConfig() {
  return cached("cf-config", async () => {
    const resp = await cf.send(new GetDistributionConfigCommand({ Id: DIST_ID }));
    return resp.DistributionConfig;
  });
}

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

export async function propfind(url, basePath, { dirResponse, fileResponse }) {
  // /fs/aws/cloudfront/
  if (url === `${basePath}/aws/cloudfront`) {
    const responses = [
      dirResponse(`${basePath}/aws/cloudfront/`, "cloudfront"),
      fileResponse(`${basePath}/aws/cloudfront/README.md`, "README.md", 0, null, "text/markdown"),
      fileResponse(`${basePath}/aws/cloudfront/general.json`, "general.json"),
      dirResponse(`${basePath}/aws/cloudfront/origins/`, "origins"),
      dirResponse(`${basePath}/aws/cloudfront/behaviors/`, "behaviors"),
      fileResponse(`${basePath}/aws/cloudfront/error-pages.json`, "error-pages.json"),
      fileResponse(`${basePath}/aws/cloudfront/logging.json`, "logging.json"),
      fileResponse(`${basePath}/aws/cloudfront/tags.json`, "tags.json"),
    ];
    return { handled: true, responses };
  }

  // /fs/aws/cloudfront/origins/
  if (url === `${basePath}/aws/cloudfront/origins`) {
    const config = await getDistConfig();
    const origins = config.Origins?.Items || [];
    const responses = [
      dirResponse(`${basePath}/aws/cloudfront/origins/`, "origins"),
      ...origins.map(o => fileResponse(
        `${basePath}/aws/cloudfront/origins/${o.Id}.json`, `${o.Id}.json`
      )),
    ];
    return { handled: true, responses };
  }

  // /fs/aws/cloudfront/behaviors/
  if (url === `${basePath}/aws/cloudfront/behaviors`) {
    const config = await getDistConfig();
    const behaviors = config.CacheBehaviors?.Items || [];
    const responses = [
      dirResponse(`${basePath}/aws/cloudfront/behaviors/`, "behaviors"),
      fileResponse(`${basePath}/aws/cloudfront/behaviors/default.json`, "default.json"),
      ...behaviors.map((b, i) => {
        const name = `${i}-${b.PathPattern.replace(/[/*]/g, "").replace(/\s/g, "-") || "path"}`;
        return fileResponse(`${basePath}/aws/cloudfront/behaviors/${name}.json`, `${name}.json`);
      }),
    ];
    return { handled: true, responses };
  }

  return { handled: false };
}

export async function get(url, basePath) {
  // /fs/aws/cloudfront/general.json
  if (url === `${basePath}/aws/cloudfront/general.json`) {
    const config = await getDistConfig();
    const content = {
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
    };
    return { handled: true, content: JSON.stringify(content, null, 2), contentType: "application/json" };
  }

  // /fs/aws/cloudfront/README.md
  if (url === `${basePath}/aws/cloudfront/README.md`) {
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

    return { handled: true, content: md, contentType: "text/markdown" };
  }

  // /fs/aws/cloudfront/error-pages.json
  if (url === `${basePath}/aws/cloudfront/error-pages.json`) {
    const config = await getDistConfig();
    const pages = (config.CustomErrorResponses?.Items || []).map(e => ({
      errorCode: e.ErrorCode,
      responseCode: e.ResponseCode,
      responsePage: e.ResponsePagePath,
      ttl: e.ErrorCachingMinTTL,
    }));
    return { handled: true, content: JSON.stringify(pages, null, 2), contentType: "application/json" };
  }

  // /fs/aws/cloudfront/logging.json
  if (url === `${basePath}/aws/cloudfront/logging.json`) {
    const config = await getDistConfig();
    const content = {
      enabled: config.Logging?.Enabled || false,
      bucket: config.Logging?.Bucket || null,
      prefix: config.Logging?.Prefix || null,
      includeCookies: config.Logging?.IncludeCookies || false,
    };
    return { handled: true, content: JSON.stringify(content, null, 2), contentType: "application/json" };
  }

  // /fs/aws/cloudfront/tags.json
  if (url === `${basePath}/aws/cloudfront/tags.json`) {
    return { handled: true, content: JSON.stringify({}, null, 2), contentType: "application/json" };
  }

  // /fs/aws/cloudfront/origins/<id>.json
  const originMatch = url.match(new RegExp(`^${basePath}/aws/cloudfront/origins/([^/]+)\\.json$`));
  if (originMatch) {
    const id = originMatch[1];
    const config = await getDistConfig();
    const origin = (config.Origins?.Items || []).find(o => o.Id === id);
    if (!origin) return { handled: true, notFound: true };
    const content = {
      id: origin.Id,
      domain: origin.DomainName,
      path: origin.OriginPath || "/",
      protocol: origin.CustomOriginConfig?.OriginProtocolPolicy || "https-only",
      s3Config: origin.S3OriginConfig || null,
      originAccessControl: origin.OriginAccessControlId || null,
    };
    return { handled: true, content: JSON.stringify(content, null, 2), contentType: "application/json" };
  }

  // /fs/aws/cloudfront/behaviors/default.json
  if (url === `${basePath}/aws/cloudfront/behaviors/default.json`) {
    const config = await getDistConfig();
    const b = config.DefaultCacheBehavior;
    return { handled: true, content: JSON.stringify(formatBehavior(b, "*"), null, 2), contentType: "application/json" };
  }

  // /fs/aws/cloudfront/behaviors/<n>-<name>.json
  const behaviorMatch = url.match(new RegExp(`^${basePath}/aws/cloudfront/behaviors/(\\d+)-([^/]+)\\.json$`));
  if (behaviorMatch) {
    const idx = parseInt(behaviorMatch[1]);
    const config = await getDistConfig();
    const b = config.CacheBehaviors?.Items?.[idx];
    if (!b) return { handled: true, notFound: true };
    return { handled: true, content: JSON.stringify(formatBehavior(b, b.PathPattern), null, 2), contentType: "application/json" };
  }

  return { handled: false };
}
