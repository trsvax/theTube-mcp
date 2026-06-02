// lambda provider — routes through the tube
// No AWS credentials. Just tubeRequest.

import { tubeRequest } from "../../tubeRequest.js";

let _functionsCache = null;
let _functionsTs = 0;
const CACHE_TTL = 60_000;

async function getLambdaFunctions() {
  if (_functionsCache && Date.now() - _functionsTs < CACHE_TTL) return _functionsCache;
  const result = await tubeRequest("aws/list-lambdas", { filter: "thetube" });
  _functionsCache = result;
  _functionsTs = Date.now();
  return result;
}

async function getLambdaConfig(name) {
  return tubeRequest("aws/get-lambda-config", { name });
}

async function getLambdaFiles(name) {
  return tubeRequest("aws/get-lambda-files", { name });
}

export async function propfind(url, basePath, { dirResponse, fileResponse }) {
  if (url === `${basePath}/aws/lambda`) {
    const fns = await getLambdaFunctions();
    const responses = [
      dirResponse(`${basePath}/aws/lambda/`, "lambda"),
      fileResponse(`${basePath}/aws/lambda/README.md`, "README.md", 0, null, "text/markdown"),
      ...fns.map(f => dirResponse(`${basePath}/aws/lambda/${f.FunctionName}/`, f.FunctionName)),
    ];
    return { handled: true, responses };
  }

  const lambdaDirMatch = url.match(new RegExp(`^${basePath}/aws/lambda/([^/]+)$`));
  if (lambdaDirMatch) {
    const name = lambdaDirMatch[1];
    if (name.startsWith("._") || name === "README.md") return { handled: true, notFound: true };
    const files = await getLambdaFiles(name);
    const responses = [
      dirResponse(`${basePath}/aws/lambda/${name}/`, name),
      fileResponse(`${basePath}/aws/lambda/${name}/config.json`, "config.json"),
      fileResponse(`${basePath}/aws/lambda/${name}/env.json`, "env.json"),
      ...(files || []).map(f => fileResponse(
        `${basePath}/aws/lambda/${name}/${f.name}`, f.name, f.size, null,
        f.name.endsWith(".js") ? "text/javascript" : "application/octet-stream"
      )),
    ];
    return { handled: true, responses };
  }

  return { handled: false };
}

export async function get(url, basePath) {
  if (url === `${basePath}/aws/lambda/README.md`) {
    const fns = await getLambdaFunctions();
    let md = `# Lambda Functions\n\n`;
    md += `Functions matching \`thetube-*\`.\n\n`;
    md += `| Function | Runtime | Memory | Timeout | Last Modified |\n`;
    md += `|----------|---------|--------|---------|---------------|\n`;
    for (const f of fns) {
      md += `| \`${f.FunctionName}\` | ${f.Runtime} | ${f.MemorySize}MB | ${f.Timeout}s | ${f.LastModified?.split("T")[0] || "—"} |\n`;
    }
    md += `\n## Details\n\n`;
    md += `Each function directory contains:\n`;
    md += `- \`config.json\` — runtime, handler, memory, timeout, role\n`;
    md += `- \`env.json\` — environment variables\n`;
    md += `- Source files extracted from the deployment package\n`;
    return { handled: true, content: md, contentType: "text/markdown" };
  }

  const lambdaConfigMatch = url.match(new RegExp(`^${basePath}/aws/lambda/([^/]+)/config\\.json$`));
  if (lambdaConfigMatch) {
    const name = lambdaConfigMatch[1];
    const cfg = await getLambdaConfig(name);
    const content = {
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
    };
    return { handled: true, content: JSON.stringify(content, null, 2), contentType: "application/json" };
  }

  const lambdaEnvMatch = url.match(new RegExp(`^${basePath}/aws/lambda/([^/]+)/env\\.json$`));
  if (lambdaEnvMatch) {
    const name = lambdaEnvMatch[1];
    const cfg = await getLambdaConfig(name);
    return { handled: true, content: JSON.stringify(cfg.Environment?.Variables || {}, null, 2), contentType: "application/json" };
  }

  const lambdaCodeMatch = url.match(new RegExp(`^${basePath}/aws/lambda/([^/]+)/(.+)$`));
  if (lambdaCodeMatch) {
    const [, name, filename] = lambdaCodeMatch;
    if (filename === "config.json" || filename === "env.json") {
      return { handled: true, notFound: true };
    }
    const files = await getLambdaFiles(name);
    const file = (files || []).find(f => f.name === filename);
    if (!file || !file.content) return { handled: true, notFound: true };
    const contentType = filename.endsWith(".js") ? "text/javascript"
      : filename.endsWith(".json") ? "application/json"
      : filename.endsWith(".mjs") ? "text/javascript"
      : "text/plain";
    return { handled: true, content: file.content, contentType };
  }

  return { handled: false };
}
