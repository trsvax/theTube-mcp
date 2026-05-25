import { inflateRawSync } from "node:zlib";
import { LambdaClient, ListFunctionsCommand, GetFunctionConfigurationCommand, GetFunctionCommand } from "@aws-sdk/client-lambda";
import { cached } from "../../cache.js";

const lambda = new LambdaClient({});

async function getLambdaFunctions() {
  return cached("lambda-list", async () => {
    const resp = await lambda.send(new ListFunctionsCommand({ MaxItems: 50 }));
    return (resp.Functions || []).filter(f => f.FunctionName.startsWith("thetube"));
  });
}

async function getLambdaConfig(name) {
  return cached(`lambda-cfg-${name}`, async () => {
    return lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
  });
}

async function getLambdaCodeUrl(name) {
  return cached(`lambda-code-${name}`, async () => {
    const resp = await lambda.send(new GetFunctionCommand({ FunctionName: name }));
    return resp.Code?.Location || null;
  });
}

// Minimal zip parser — uses central directory for reliable extraction
function parseZip(buf) {
  const files = [];
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) return files;

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdEntries = buf.readUInt16LE(eocdOffset + 10);

  let offset = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf-8", offset + 46, offset + 46 + nameLen);

    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let content;
    if (method === 0) content = raw;
    else if (method === 8) content = inflateRawSync(raw);
    else content = null;

    if (name && !name.endsWith("/")) {
      files.push({ name, content, size: uncompSize });
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function getLambdaFiles(name) {
  return cached(`lambda-files-${name}`, async () => {
    try {
      const codeUrl = await getLambdaCodeUrl(name);
      if (!codeUrl) return [];
      const resp = await fetch(codeUrl);
      if (!resp.ok) return [];
      const buf = Buffer.from(await resp.arrayBuffer());
      return parseZip(buf);
    } catch {
      return [];
    }
  });
}

export async function propfind(url, basePath, { dirResponse, fileResponse }) {
  // /fs/aws/lambda/
  if (url === `${basePath}/aws/lambda`) {
    const fns = await getLambdaFunctions();
    const responses = [
      dirResponse(`${basePath}/aws/lambda/`, "lambda"),
      fileResponse(`${basePath}/aws/lambda/README.md`, "README.md", 0, null, "text/markdown"),
      ...fns.map(f => dirResponse(`${basePath}/aws/lambda/${f.FunctionName}/`, f.FunctionName)),
    ];
    return { handled: true, responses };
  }

  // /fs/aws/lambda/<name>/
  const lambdaDirMatch = url.match(new RegExp(`^${basePath}/aws/lambda/([^/]+)$`));
  if (lambdaDirMatch) {
    const name = lambdaDirMatch[1];
    if (name.startsWith("._") || name === "README.md") return { handled: true, notFound: true };
    const files = await getLambdaFiles(name);
    const responses = [
      dirResponse(`${basePath}/aws/lambda/${name}/`, name),
      fileResponse(`${basePath}/aws/lambda/${name}/config.json`, "config.json"),
      fileResponse(`${basePath}/aws/lambda/${name}/env.json`, "env.json"),
      ...files.map(f => fileResponse(
        `${basePath}/aws/lambda/${name}/${f.name}`, f.name, f.size, null,
        f.name.endsWith(".js") ? "text/javascript" : "application/octet-stream"
      )),
    ];
    return { handled: true, responses };
  }

  return { handled: false };
}

export async function get(url, basePath) {
  // /fs/aws/lambda/README.md
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

  // /fs/aws/lambda/<name>/config.json
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

  // /fs/aws/lambda/<name>/env.json
  const lambdaEnvMatch = url.match(new RegExp(`^${basePath}/aws/lambda/([^/]+)/env\\.json$`));
  if (lambdaEnvMatch) {
    const name = lambdaEnvMatch[1];
    const cfg = await getLambdaConfig(name);
    return { handled: true, content: JSON.stringify(cfg.Environment?.Variables || {}, null, 2), contentType: "application/json" };
  }

  // /fs/aws/lambda/<name>/<file> (code files from deployment package)
  const lambdaCodeMatch = url.match(new RegExp(`^${basePath}/aws/lambda/([^/]+)/(.+)$`));
  if (lambdaCodeMatch) {
    const [, name, filename] = lambdaCodeMatch;
    if (filename === "config.json" || filename === "env.json") {
      return { handled: true, notFound: true };
    }
    const files = await getLambdaFiles(name);
    const file = files.find(f => f.name === filename);
    if (!file || !file.content) return { handled: true, notFound: true };
    const contentType = filename.endsWith(".js") ? "text/javascript"
      : filename.endsWith(".json") ? "application/json"
      : filename.endsWith(".mjs") ? "text/javascript"
      : "text/plain";
    return { handled: true, content: file.content, contentType, binary: true };
  }

  return { handled: false };
}
