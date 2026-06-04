---
title: The WebDAV Server
date: 2026-06-04
tags: [tech, src]
type: journal
audience: owner
status: journaling
coffee: 1
summary: Mount the tube as a filesystem. PROPFIND lists, GET reads, POST writes. Providers route through tubeRequest — no AWS credentials here.
workflow: draft
deploy:
  type: module
  name: server.js
  target: webdav/server.js
  code: js
---

## Mount the tube

A WebDAV server on localhost. Mount it and browse AWS, logs, content, the tube itself — all as folders and files. Finder reads it. `ls` reads it. The MCP server reads it.

```
mkdir -p /tmp/tube && mount -t webdav http://localhost:8080/fs/ /tmp/tube
```

No AWS credentials in this process. Every AWS read routes through `tubeRequest()` → ticket machine → processor. The server is just a URL→path router that speaks WebDAV XML.

```js # src
import http from "node:http";

import * as content from "./providers/content.js";
import * as logs from "./providers/logs.js";
import * as tube from "./providers/tube.js";
import * as cloudfront from "./providers/aws/cloudfront.js";
import * as lambdaProvider from "./providers/aws/lambda.js";
import * as s3Provider from "./providers/aws/s3.js";
import * as cognitoProvider from "./providers/aws/cognito.js";
import * as iamProvider from "./providers/aws/iam.js";

const PORT = process.env.PORT || 8080;
const BASE_PATH = "/fs";
```

## WebDAV XML

The protocol is verbose but mechanical. Directories are `<D:collection/>`, files have content-length and type. Every response is a `multistatus` wrapper around individual `response` elements.

```js # src
function multistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${responses.join("\n")}
</D:multistatus>`;
}

function dirResponse(href, displayname) {
  return `  <D:response>
    <D:href>${href}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${displayname}</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:getlastmodified>${new Date().toUTCString()}</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}

function fileResponse(href, displayname, size, modified, contentType) {
  return `  <D:response>
    <D:href>${href}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${displayname}</D:displayname>
        <D:resourcetype/>
        <D:getcontentlength>${size || 0}</D:getcontentlength>
        <D:getlastmodified>${modified || new Date().toUTCString()}</D:getlastmodified>
        <D:getcontenttype>${contentType || "application/json"}</D:getcontenttype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}

function text(res, content, type) {
  res.writeHead(200, { "Content-Type": type, "Content-Length": Buffer.byteLength(content) });
  res.end(content);
}

const helpers = { dirResponse, fileResponse };
```

## Request handler

Three verbs: PROPFIND (list), GET (read), POST (write to tube). Each verb iterates through providers in order until one claims the URL. First match wins.

The root PROPFIND builds the top-level listing: content types from posts, plus logs, aws, and tube directories.

```js # src
async function handleRequest(req, res) {
  const url = decodeURIComponent(req.url).replace(/\/$/, "") || BASE_PATH;
  const method = req.method.toUpperCase();

  console.log(`${method} ${url}`);

  if (method === "OPTIONS") {
    res.writeHead(200, { "DAV": "1", "Allow": "OPTIONS, PROPFIND, GET, HEAD", "Content-Length": "0" });
    res.end();
    return;
  }

  try {
    // macOS resource fork noise
    if (url.includes("/._")) {
      res.writeHead(404);
      res.end();
      return;
    }

    // PROPFIND — directory listings
    if (method === "PROPFIND") {

      if (url === BASE_PATH || url === `${BASE_PATH}/`) {
        const posts = content.getPosts();
        const types = content.getTypes(posts);
        const responses = [
          dirResponse(`${BASE_PATH}/`, "fs"),
          ...types.map(t => dirResponse(`${BASE_PATH}/${t}/`, t)),
          dirResponse(`${BASE_PATH}/logs/`, "logs"),
          dirResponse(`${BASE_PATH}/aws/`, "aws"),
          dirResponse(`${BASE_PATH}/tube/`, "tube"),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      if (url === `${BASE_PATH}/aws`) {
        const responses = [
          dirResponse(`${BASE_PATH}/aws/`, "aws"),
          dirResponse(`${BASE_PATH}/aws/cloudfront/`, "cloudfront"),
          dirResponse(`${BASE_PATH}/aws/lambda/`, "lambda"),
          dirResponse(`${BASE_PATH}/aws/s3/`, "s3"),
          dirResponse(`${BASE_PATH}/aws/cognito/`, "cognito"),
          dirResponse(`${BASE_PATH}/aws/iam/`, "iam"),
        ];
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(multistatus(responses));
        return;
      }

      const propfindProviders = [
        cloudfront, lambdaProvider, s3Provider, cognitoProvider, iamProvider,
        tube, logs, content,
      ];

      for (const provider of propfindProviders) {
        const result = await provider.propfind(url, BASE_PATH, helpers);
        if (result.handled) {
          if (result.notFound) { res.writeHead(404); res.end(); return; }
          const responses = result.async ? await result.fn() : result.responses;
          res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
          res.end(multistatus(responses));
          return;
        }
      }

      res.writeHead(404);
      res.end();
      return;
    }

    // GET / HEAD — file content
    if (method === "GET" || method === "HEAD") {

      const getProviders = [
        cloudfront, lambdaProvider, s3Provider, cognitoProvider, iamProvider,
        logs, tube, content,
      ];

      for (const provider of getProviders) {
        const result = await provider.get(url, BASE_PATH);
        if (result.handled) {
          if (result.notFound) { res.writeHead(404); res.end(); return; }
          if (result.binary) {
            res.writeHead(200, {
              "Content-Type": result.contentType,
              "Content-Length": result.content.length,
            });
            if (method === "GET") res.end(result.content);
            else res.end();
          } else {
            if (method === "GET") text(res, result.content, result.contentType);
            else {
              res.writeHead(200, {
                "Content-Type": result.contentType,
                "Content-Length": Buffer.byteLength(result.content),
              });
              res.end();
            }
          }
          return;
        }
      }

      res.writeHead(404);
      res.end();
      return;
    }

    // POST — write to tube
    if (method === "POST") {
      const result = tube.post(req, url, BASE_PATH);
      if (result.handled) {
        result.handler(res);
        return;
      }
      res.writeHead(404);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end(err.message);
  }
}
```

## Start

```js # src
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`WebDAV server running on http://localhost:${PORT}${BASE_PATH}/`);
  console.log(`Providers: content, logs, tube, aws/cloudfront, aws/lambda, aws/s3, aws/cognito, aws/iam`);
  console.log("");
  console.log("Mount with:");
  console.log(`  mkdir -p /tmp/tube && mount -t webdav http://localhost:${PORT}${BASE_PATH}/ /tmp/tube`);
});
```

[journey]:
prev: tubeRequest
next:
The WebDAV server was the first thing built — before the tube existed. It started with direct AWS SDK calls in each provider. Then tubeRequest replaced them. Now the server is just HTTP routing + XML formatting. All the intelligence is in the providers, and all the AWS access is in the processor Lambda on the other side of the tube. This file will probably shrink further as providers become self-registering.
