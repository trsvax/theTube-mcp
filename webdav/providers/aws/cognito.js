// Cognito user pool provider
import { CognitoIdentityProviderClient, DescribeUserPoolCommand, ListUserPoolClientsCommand, DescribeUserPoolClientCommand, ListGroupsCommand } from "@aws-sdk/client-cognito-identity-provider";
import { cached } from "../../cache.js";

const COGNITO_POOL_ID = process.env.COGNITO_POOL_ID || "us-east-1_YJXzLNxyi";
const cognito = new CognitoIdentityProviderClient({});

async function getPool() {
  return cached("cognito-pool", async () => {
    const resp = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: COGNITO_POOL_ID }));
    return resp.UserPool;
  });
}

async function getClients() {
  return cached("cognito-clients", async () => {
    const resp = await cognito.send(new ListUserPoolClientsCommand({ UserPoolId: COGNITO_POOL_ID, MaxResults: 10 }));
    const clients = [];
    for (const c of resp.UserPoolClients || []) {
      const detail = await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: COGNITO_POOL_ID, ClientId: c.ClientId }));
      clients.push(detail.UserPoolClient);
    }
    return clients;
  });
}

async function getGroups() {
  return cached("cognito-groups", async () => {
    const resp = await cognito.send(new ListGroupsCommand({ UserPoolId: COGNITO_POOL_ID }));
    return resp.Groups || [];
  });
}

export async function propfind(url, basePath, { dirResponse, fileResponse }) {
  // /fs/aws/cognito/
  if (url === `${basePath}/aws/cognito`) {
    const responses = [
      dirResponse(`${basePath}/aws/cognito/`, "cognito"),
      fileResponse(`${basePath}/aws/cognito/README.md`, "README.md", 0, null, "text/markdown"),
      fileResponse(`${basePath}/aws/cognito/pool.json`, "pool.json"),
      dirResponse(`${basePath}/aws/cognito/clients/`, "clients"),
      dirResponse(`${basePath}/aws/cognito/groups/`, "groups"),
    ];
    return { handled: true, responses };
  }

  // /fs/aws/cognito/clients/
  if (url === `${basePath}/aws/cognito/clients`) {
    return { handled: true, async: true, fn: async () => {
      const clients = await getClients();
      return [
        dirResponse(`${basePath}/aws/cognito/clients/`, "clients"),
        ...clients.map(c => fileResponse(
          `${basePath}/aws/cognito/clients/${c.ClientName}.json`, `${c.ClientName}.json`
        )),
      ];
    }};
  }

  // /fs/aws/cognito/groups/
  if (url === `${basePath}/aws/cognito/groups`) {
    return { handled: true, async: true, fn: async () => {
      const groups = await getGroups();
      return [
        dirResponse(`${basePath}/aws/cognito/groups/`, "groups"),
        ...groups.map(g => fileResponse(
          `${basePath}/aws/cognito/groups/${g.GroupName}.json`, `${g.GroupName}.json`
        )),
      ];
    }};
  }

  return { handled: false };
}

export async function get(url, basePath) {
  // /fs/aws/cognito/README.md
  if (url === `${basePath}/aws/cognito/README.md`) {
    const pool = await getPool();
    const clients = await getClients();
    const groups = await getGroups();

    let md = `# Cognito: ${pool.Name}\n\n`;
    md += `Pool ID: \`${COGNITO_POOL_ID}\`\n`;
    md += `Domain: \`${pool.Domain}.auth.${pool.Id.split("_")[0]}.amazoncognito.com\`\n`;
    md += `Status: ${pool.Status}\n`;
    md += `Created: ${pool.CreationDate?.toISOString().split("T")[0]}\n\n`;

    md += `## Clients (${clients.length})\n\n`;
    for (const c of clients) {
      md += `- \`${c.ClientName}\` — ${c.ClientId}\n`;
    }

    md += `\n## Groups (${groups.length})\n\n`;
    for (const g of groups) {
      md += `- \`${g.GroupName}\`${g.Description ? ` — ${g.Description}` : ""}\n`;
    }

    md += `\n## Auth flow\n\n`;
    md += `1. User clicks Sign in → Cognito hosted UI\n`;
    md += `2. Cognito redirects to \`/callback\` with auth code\n`;
    md += `3. \`thetube-auth-callback\` Lambda exchanges code for tokens\n`;
    md += `4. Sets \`thetube_token\` (HttpOnly), \`thetube_user\`, \`thetube_roles\` cookies\n`;
    md += `5. \`thetube-edge-auth\` Lambda@Edge validates JWT on protected paths\n`;

    return { handled: true, content: md, contentType: "text/markdown" };
  }

  // /fs/aws/cognito/pool.json
  if (url === `${basePath}/aws/cognito/pool.json`) {
    const pool = await getPool();
    const content = {
      id: pool.Id,
      name: pool.Name,
      status: pool.Status,
      domain: pool.Domain,
      created: pool.CreationDate?.toISOString(),
      lastModified: pool.LastModifiedDate?.toISOString(),
      estimatedUsers: pool.EstimatedNumberOfUsers,
      mfaConfig: pool.MfaConfiguration,
      policies: pool.Policies,
      autoVerifiedAttributes: pool.AutoVerifiedAttributes,
      usernameAttributes: pool.UsernameAttributes,
    };
    return { handled: true, content: JSON.stringify(content, null, 2), contentType: "application/json" };
  }

  // /fs/aws/cognito/clients/<name>.json
  const clientMatch = url.match(new RegExp(`^${basePath}/aws/cognito/clients/([^/]+)\\.json$`));
  if (clientMatch) {
    const name = decodeURIComponent(clientMatch[1]);
    const clients = await getClients();
    const client = clients.find(c => c.ClientName === name);
    if (!client) return { handled: true, notFound: true };
    const content = {
      clientId: client.ClientId,
      clientName: client.ClientName,
      callbackURLs: client.CallbackURLs,
      logoutURLs: client.LogoutURLs,
      allowedOAuthFlows: client.AllowedOAuthFlows,
      allowedOAuthScopes: client.AllowedOAuthScopes,
      supportedIdentityProviders: client.SupportedIdentityProviders,
      tokenValidity: {
        accessToken: client.AccessTokenValidity,
        idToken: client.IdTokenValidity,
        refreshToken: client.RefreshTokenValidity,
      },
    };
    return { handled: true, content: JSON.stringify(content, null, 2), contentType: "application/json" };
  }

  // /fs/aws/cognito/groups/<name>.json
  const groupMatch = url.match(new RegExp(`^${basePath}/aws/cognito/groups/([^/]+)\\.json$`));
  if (groupMatch) {
    const name = decodeURIComponent(groupMatch[1]);
    const groups = await getGroups();
    const group = groups.find(g => g.GroupName === name);
    if (!group) return { handled: true, notFound: true };
    const content = {
      name: group.GroupName,
      description: group.Description,
      precedence: group.Precedence,
      roleArn: group.RoleArn,
      created: group.CreationDate?.toISOString(),
      lastModified: group.LastModifiedDate?.toISOString(),
    };
    return { handled: true, content: JSON.stringify(content, null, 2), contentType: "application/json" };
  }

  return { handled: false };
}
