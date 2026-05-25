// IAM provider — roles and users relevant to thetube
import { IAMClient, ListRolesCommand, GetRoleCommand, ListRolePoliciesCommand, GetRolePolicyCommand, ListAttachedRolePoliciesCommand, ListUsersCommand, ListUserPoliciesCommand, GetUserPolicyCommand, ListAttachedUserPoliciesCommand } from "@aws-sdk/client-iam";
import { cached } from "../../cache.js";

const IAM_ROLE_FILTER = process.env.IAM_ROLE_FILTER || "thetube,InfraStack";
const iam = new IAMClient({});

async function getRoles() {
  return cached("iam-roles", async () => {
    const resp = await iam.send(new ListRolesCommand({ MaxItems: 100 }));
    const filters = IAM_ROLE_FILTER.split(",");
    return (resp.Roles || []).filter(r => filters.some(f => r.RoleName.includes(f)));
  });
}

async function getRoleDetail(roleName) {
  return cached(`iam-role-${roleName}`, async () => {
    const [role, inlineResp, attachedResp] = await Promise.all([
      iam.send(new GetRoleCommand({ RoleName: roleName })),
      iam.send(new ListRolePoliciesCommand({ RoleName: roleName })),
      iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName })),
    ]);
    const inline = [];
    for (const pName of inlineResp.PolicyNames || []) {
      const p = await iam.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: pName }));
      inline.push({ name: pName, document: JSON.parse(decodeURIComponent(p.PolicyDocument)) });
    }
    return {
      trust: role.Role.AssumeRolePolicyDocument || {},
      inlinePolicies: inline,
      attachedPolicies: attachedResp.AttachedPolicies || [],
    };
  });
}

async function getUsers() {
  return cached("iam-users", async () => {
    const resp = await iam.send(new ListUsersCommand({ MaxItems: 50 }));
    return resp.Users || [];
  });
}

async function getUserDetail(userName) {
  return cached(`iam-user-${userName}`, async () => {
    const [inlineResp, attachedResp] = await Promise.all([
      iam.send(new ListUserPoliciesCommand({ UserName: userName })),
      iam.send(new ListAttachedUserPoliciesCommand({ UserName: userName })),
    ]);
    const inline = [];
    for (const pName of inlineResp.PolicyNames || []) {
      const p = await iam.send(new GetUserPolicyCommand({ UserName: userName, PolicyName: pName }));
      inline.push({ name: pName, document: JSON.parse(decodeURIComponent(p.PolicyDocument)) });
    }
    return {
      inlinePolicies: inline,
      attachedPolicies: attachedResp.AttachedPolicies || [],
    };
  });
}

export async function propfind(url, basePath, { dirResponse, fileResponse }) {
  // /fs/aws/iam/
  if (url === `${basePath}/aws/iam`) {
    const responses = [
      dirResponse(`${basePath}/aws/iam/`, "iam"),
      fileResponse(`${basePath}/aws/iam/README.md`, "README.md", 0, null, "text/markdown"),
      dirResponse(`${basePath}/aws/iam/roles/`, "roles"),
      dirResponse(`${basePath}/aws/iam/users/`, "users"),
    ];
    return { handled: true, responses };
  }

  // /fs/aws/iam/roles/
  if (url === `${basePath}/aws/iam/roles`) {
    return { handled: true, async: true, fn: async () => {
      const roles = await getRoles();
      return [
        dirResponse(`${basePath}/aws/iam/roles/`, "roles"),
        ...roles.map(r => dirResponse(`${basePath}/aws/iam/roles/${r.RoleName}/`, r.RoleName)),
      ];
    }};
  }

  // /fs/aws/iam/roles/<name>/
  const roleMatch = url.match(new RegExp(`^${basePath}/aws/iam/roles/([^/]+)$`));
  if (roleMatch) {
    const name = roleMatch[1];
    return { handled: true, responses: [
      dirResponse(`${basePath}/aws/iam/roles/${name}/`, name),
      fileResponse(`${basePath}/aws/iam/roles/${name}/trust.json`, "trust.json"),
      fileResponse(`${basePath}/aws/iam/roles/${name}/policies.json`, "policies.json"),
    ]};
  }

  // /fs/aws/iam/users/
  if (url === `${basePath}/aws/iam/users`) {
    return { handled: true, async: true, fn: async () => {
      const users = await getUsers();
      return [
        dirResponse(`${basePath}/aws/iam/users/`, "users"),
        ...users.map(u => dirResponse(`${basePath}/aws/iam/users/${u.UserName}/`, u.UserName)),
      ];
    }};
  }

  // /fs/aws/iam/users/<name>/
  const userMatch = url.match(new RegExp(`^${basePath}/aws/iam/users/([^/]+)$`));
  if (userMatch) {
    const name = userMatch[1];
    return { handled: true, responses: [
      dirResponse(`${basePath}/aws/iam/users/${name}/`, name),
      fileResponse(`${basePath}/aws/iam/users/${name}/policies.json`, "policies.json"),
    ]};
  }

  return { handled: false };
}

export async function get(url, basePath) {
  // /fs/aws/iam/README.md
  if (url === `${basePath}/aws/iam/README.md`) {
    const roles = await getRoles();
    const users = await getUsers();
    let md = `# IAM\n\n`;
    md += `## Roles (${roles.length})\n\n`;
    for (const r of roles) {
      md += `- \`${r.RoleName}\`\n`;
    }
    md += `\n## Users (${users.length})\n\n`;
    for (const u of users) {
      md += `- \`${u.UserName}\`\n`;
    }
    md += `\nEach role/user directory has \`trust.json\` and/or \`policies.json\`.\n`;
    return { handled: true, content: md, contentType: "text/markdown" };
  }

  // /fs/aws/iam/roles/<name>/trust.json
  const trustMatch = url.match(new RegExp(`^${basePath}/aws/iam/roles/([^/]+)/trust\\.json$`));
  if (trustMatch) {
    const detail = await getRoleDetail(trustMatch[1]);
    const trust = typeof detail.trust === "string" ? JSON.parse(decodeURIComponent(detail.trust)) : detail.trust;
    return { handled: true, content: JSON.stringify(trust, null, 2), contentType: "application/json" };
  }

  // /fs/aws/iam/roles/<name>/policies.json
  const rolePoliciesMatch = url.match(new RegExp(`^${basePath}/aws/iam/roles/([^/]+)/policies\\.json$`));
  if (rolePoliciesMatch) {
    const detail = await getRoleDetail(rolePoliciesMatch[1]);
    const content = {
      inline: detail.inlinePolicies,
      attached: detail.attachedPolicies,
    };
    return { handled: true, content: JSON.stringify(content, null, 2), contentType: "application/json" };
  }

  // /fs/aws/iam/users/<name>/policies.json
  const userPoliciesMatch = url.match(new RegExp(`^${basePath}/aws/iam/users/([^/]+)/policies\\.json$`));
  if (userPoliciesMatch) {
    const detail = await getUserDetail(userPoliciesMatch[1]);
    const content = {
      inline: detail.inlinePolicies,
      attached: detail.attachedPolicies,
    };
    return { handled: true, content: JSON.stringify(content, null, 2), contentType: "application/json" };
  }

  return { handled: false };
}
