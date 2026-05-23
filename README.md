# theTube-mcp

Local MCP server for [theTube](https://thetube.today). Read-only AWS access from your Mac.

## What it does

- Query CloudFront logs (find captures, trace 403s, check deploys)
- Inspect Lambda functions (config, runtime, env vars)
- Read CloudFront distribution config (behaviors, edge functions)
- Track state in SQLite (captures, tokens, deploys) — future

All reads. No writes to AWS. IAM-enforced.

## Setup

```bash
npm install
```

Configure in `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "thetube": {
      "command": "node",
      "args": ["src/index.js"],
      "cwd": "/Users/bfb/github/theTube/theTube-mcp",
      "env": {
        "AWS_REGION": "us-east-1",
        "LOG_BUCKET": "thetube-logs"
      }
    }
  }
}
```

## Tools

| Tool | What it does |
|------|-------------|
| `list_recent_logs` | List recent CloudFront log files |
| `read_log` | Read and filter a log file by path/status |
| `query_captures` | Find share captures for a given date |
| `list_lambdas` | List all Lambda functions |
| `get_lambda_config` | Get a function's config (runtime, env, memory) |
| `get_distribution` | Get CloudFront distribution behaviors and edge functions |

## Example queries

"What captures came in today?"
→ `query_captures`

"Is /w/ wired up on CloudFront?"
→ `get_distribution` with ID `E2DMNPNLN0VAQM`

"Why did this request get a 403?"
→ `read_log` filtered by status 403

"What Lambda functions exist?"
→ `list_lambdas`

## Security

- Runs locally on your Mac
- Uses your local AWS credentials (~/.aws or env)
- IAM role should be scoped to read-only
- No credentials stored in this repo
