// S3 buckets provider — stub for now

export async function propfind(url, basePath, { dirResponse, fileResponse }) {
  if (url === `${basePath}/aws/s3`) {
    const responses = [
      dirResponse(`${basePath}/aws/s3/`, "s3"),
      fileResponse(`${basePath}/aws/s3/README.md`, "README.md", 0, null, "text/markdown"),
    ];
    return { handled: true, responses };
  }

  return { handled: false };
}

export async function get(url, basePath) {
  if (url === `${basePath}/aws/s3/README.md`) {
    const md = `# S3 Buckets\n\nComing soon.\n`;
    return { handled: true, content: md, contentType: "text/markdown" };
  }

  return { handled: false };
}
