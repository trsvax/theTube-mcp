import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { LambdaClient, ListFunctionsCommand, GetFunctionCommand } from "@aws-sdk/client-lambda";
import { CloudFrontClient, GetDistributionCommand } from "@aws-sdk/client-cloudfront";
import { CloudWatchLogsClient, GetLogEventsCommand, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { createGunzip } from "zlib";

const REGION = process.env.AWS_REGION || "us-east-1";
const LOG_BUCKET = process.env.LOG_BUCKET || "thetube-logs";
const LOG_PREFIX = process.env.LOG_PREFIX || "cf-logs/";

const s3 = new S3Client({ region: REGION });
const lambda = new LambdaClient({ region: REGION });
const cf = new CloudFrontClient({ region: REGION });
const cwl = new CloudWatchLogsClient({ region: REGION });

const server = new Server(
  { name: "thetube-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// --- Tool definitions ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_recent_logs",
      description: "List recent CloudFront log files from S3",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max files to return (default 20)" },
        },
      },
    },
    {
      name: "read_log",
      description: "Read and filter a CloudFront log file. Returns parsed entries.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "S3 key of the log file" },
          pathFilter: { type: "string", description: "Filter entries by URL path (e.g. /w/share)" },
          statusFilter: { type: "string", description: "Filter by HTTP status (e.g. 403, 202)" },
        },
        required: ["key"],
      },
    },
    {
      name: "list_lambdas",
      description: "List all Lambda functions in the account",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_lambda_config",
      description: "Get configuration for a specific Lambda function",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Function name" },
        },
        required: ["name"],
      },
    },
    {
      name: "get_distribution",
      description: "Get CloudFront distribution configuration including behaviors and edge functions",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Distribution ID (e.g. E2DMNPNLN0VAQM)" },
        },
        required: ["id"],
      },
    },
    {
      name: "query_captures",
      description: "Search CloudFront logs for share captures (/w/share/add requests)",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date to search (YYYY-MM-DD, default today)" },
          device: { type: "string", description: "Filter by device (from user-agent)" },
        },
      },
    },
  ],
}));

// --- Tool implementations ---

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_recent_logs": {
        const limit = args?.limit || 20;
        const response = await s3.send(new ListObjectsV2Command({
          Bucket: LOG_BUCKET,
          Prefix: LOG_PREFIX,
          MaxKeys: 1000,
        }));
        const files = (response.Contents || [])
          .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0))
          .slice(0, limit)
          .map(f => ({ key: f.Key, size: f.Size, modified: f.LastModified?.toISOString() }));
        return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
      }

      case "read_log": {
        const { key, pathFilter, statusFilter } = args;
        const response = await s3.send(new GetObjectCommand({ Bucket: LOG_BUCKET, Key: key }));
        const body = await streamToString(response.Body, key.endsWith(".gz"));
        const entries = parseCloudFrontLog(body)
          .filter(e => !pathFilter || e.path.includes(pathFilter))
          .filter(e => !statusFilter || e.status === statusFilter);
        return { content: [{ type: "text", text: JSON.stringify(entries.slice(0, 50), null, 2) }] };
      }

      case "list_lambdas": {
        const response = await lambda.send(new ListFunctionsCommand({}));
        const fns = (response.Functions || []).map(f => ({
          name: f.FunctionName,
          runtime: f.Runtime,
          lastModified: f.LastModified,
          memorySize: f.MemorySize,
        }));
        return { content: [{ type: "text", text: JSON.stringify(fns, null, 2) }] };
      }

      case "get_lambda_config": {
        const response = await lambda.send(new GetFunctionCommand({ FunctionName: args.name }));
        const config = {
          name: response.Configuration?.FunctionName,
          runtime: response.Configuration?.Runtime,
          handler: response.Configuration?.Handler,
          memorySize: response.Configuration?.MemorySize,
          timeout: response.Configuration?.Timeout,
          lastModified: response.Configuration?.LastModified,
          environment: response.Configuration?.Environment?.Variables,
          role: response.Configuration?.Role,
        };
        return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }] };
      }

      case "get_distribution": {
        const response = await cf.send(new GetDistributionCommand({ Id: args.id }));
        const dist = response.Distribution;
        const behaviors = dist?.DistributionConfig?.CacheBehaviors?.Items?.map(b => ({
          pathPattern: b.PathPattern,
          viewerProtocolPolicy: b.ViewerProtocolPolicy,
          lambdaAssociations: b.LambdaFunctionAssociations?.Items?.map(l => ({
            eventType: l.EventType,
            functionArn: l.LambdaFunctionARN,
          })),
          functionAssociations: b.FunctionAssociations?.Items?.map(f => ({
            eventType: f.EventType,
            functionArn: f.FunctionARN,
          })),
        }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              id: dist?.Id,
              domain: dist?.DomainName,
              aliases: dist?.DistributionConfig?.Aliases?.Items,
              defaultBehavior: {
                viewerProtocolPolicy: dist?.DistributionConfig?.DefaultCacheBehavior?.ViewerProtocolPolicy,
                lambdaAssociations: dist?.DistributionConfig?.DefaultCacheBehavior?.LambdaFunctionAssociations?.Items,
                functionAssociations: dist?.DistributionConfig?.DefaultCacheBehavior?.FunctionAssociations?.Items,
              },
              behaviors,
              status: dist?.Status,
            }, null, 2),
          }],
        };
      }

      case "query_captures": {
        const date = args?.date || new Date().toISOString().split("T")[0];
        const response = await s3.send(new ListObjectsV2Command({
          Bucket: LOG_BUCKET,
          Prefix: `${LOG_PREFIX}`,
          MaxKeys: 100,
        }));
        const files = (response.Contents || [])
          .filter(f => f.Key?.includes(date.replace(/-/g, "")))
          .slice(0, 10);
        
        const captures = [];
        for (const file of files) {
          const logResponse = await s3.send(new GetObjectCommand({ Bucket: LOG_BUCKET, Key: file.Key }));
          const body = await streamToString(logResponse.Body, file.Key.endsWith(".gz"));
          const entries = parseCloudFrontLog(body)
            .filter(e => e.path.includes("/w/share") || e.path.includes("/w/") && e.queryString?.includes("type="));
          if (args?.device) {
            captures.push(...entries.filter(e => e.userAgent?.toLowerCase().includes(args.device.toLowerCase())));
          } else {
            captures.push(...entries);
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(captures, null, 2) }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

// --- Helpers ---

async function streamToString(stream, gzipped = false) {
  const chunks = [];
  if (gzipped) {
    const gunzip = createGunzip();
    stream.pipe(gunzip);
    for await (const chunk of gunzip) chunks.push(chunk);
  } else {
    for await (const chunk of stream) chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function parseCloudFrontLog(text) {
  return text.split("\n")
    .filter(line => line && !line.startsWith("#"))
    .map(line => {
      const fields = line.split("\t");
      if (fields.length < 12) return null;
      return {
        date: fields[0],
        time: fields[1],
        edgeLocation: fields[2],
        ip: fields[4],
        method: fields[5],
        host: fields[6],
        path: fields[7],
        status: fields[8],
        userAgent: fields[10],
        queryString: fields[11] === "-" ? null : fields[11],
      };
    })
    .filter(Boolean);
}

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
