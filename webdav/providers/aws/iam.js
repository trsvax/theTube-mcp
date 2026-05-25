// IAM roles provider — stub for now

export async function propfind(url, basePath, { dirResponse, fileResponse }) {
  if (url === `${basePath}/aws/iam`) {
    const responses = [
      dirResponse(`${basePath}/aws/iam/`, "iam"),
      fileResponse(`${basePath}/aws/iam/README.md`, "README.md", 0, null, "text/markdown"),
    ];
    return { handled: true, responses };
  }

  return { handled: false };
}

export async function get(url, basePath) {
  if (url === `${basePath}/aws/iam/README.md`) {
    const md = `# IAM Roles\n\nComing soon.\n`;
    return { handled: true, content: md, contentType: "text/markdown" };
  }

  return { handled: false };
}
