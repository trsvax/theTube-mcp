// Cognito user pool provider — stub for now

export async function propfind(url, basePath, { dirResponse, fileResponse }) {
  if (url === `${basePath}/aws/cognito`) {
    const responses = [
      dirResponse(`${basePath}/aws/cognito/`, "cognito"),
      fileResponse(`${basePath}/aws/cognito/README.md`, "README.md", 0, null, "text/markdown"),
    ];
    return { handled: true, responses };
  }

  return { handled: false };
}

export async function get(url, basePath) {
  if (url === `${basePath}/aws/cognito/README.md`) {
    const md = `# Cognito User Pool\n\nComing soon.\n`;
    return { handled: true, content: md, contentType: "text/markdown" };
  }

  return { handled: false };
}
