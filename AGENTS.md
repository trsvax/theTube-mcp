# AGENTS.md

Guidance for automated agents working in this repository.

## Don't make assumptions. If you don't know something, say so.

---

## Project Overview

`theTube-mcp` is a local MCP server for the theTube platform. It provides read-only access to AWS infrastructure (CloudFront logs, Lambda configs, distribution state) and local state tracking.

Runs on your Mac. Uses local AWS credentials. No cloud deployment.

---

## Architecture

```
src/
  index.js          MCP server — tool definitions and implementations

package.json        Dependencies (AWS SDK, MCP SDK)
README.md           Setup and usage
AGENTS.md           This file
```

## What it does

- Reads CloudFront logs from S3 (query captures, filter by path/status/date)
- Lists and inspects Lambda functions
- Gets CloudFront distribution config (behaviors, edge functions)
- All read-only. No mutations to AWS.

## How to run

```bash
npm install
npm start
```

Or configure in `.kiro/settings/mcp.json` (see README).

## Security

- Runs locally on Mac — no cloud deployment
- Uses local AWS credentials
- IAM role should be read-only
- No secrets in this repo

## Related

- `trsvax/theTube-share` — share system spec, auth model, scripts
- `trsvax/thetube-private` — infra, CDK stack, Lambda source
- `trsvax/theTube-content` — blog posts including mcp-log-reader.md

_Last updated: 2026-05-23_
