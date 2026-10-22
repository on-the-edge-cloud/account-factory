import { Octokit } from "@octokit/rest";

const owner = "on-the-edge-cloud";

export interface RepositorySnapshot {
  exists: boolean;
  htmlUrl?: string;
  branch: string;
  headSha?: string;
  treeSha?: string;
  paths: Set<string>;
  manifest?: string;
}

export interface RepositoryCommitResult {
  repositoryUrl: string;
  branch: string;
  commitSha: string;
}

export async function inspectProjectRepository(
  token: string,
  projectName: string,
): Promise<RepositorySnapshot> {
  const octokit = new Octokit({ auth: token });
  await octokit.orgs.get({ org: owner }).catch(() => {
    throw new Error(
      `GitHub token cannot verify access to organization ${owner}; no AWS account was created.`,
    );
  });

  let repository;
  try {
    repository = await octokit.repos.get({ owner, repo: projectName });
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    const visibleRepositories = await octokit.paginate(
      octokit.repos.listForOrg,
      { org: owner, type: "all", per_page: 100 },
    );
    if (
      visibleRepositories.some(
        (item) => item.name.toLowerCase() === projectName.toLowerCase(),
      )
    ) {
      throw new Error(
        `Repository ${owner}/${projectName} is listed in the organization but is not accessible to this token; no AWS account was created.`,
      );
    }
    return { exists: false, branch: "main", paths: new Set() };
  }

  const branch = repository.data.default_branch;
  const ref = await octokit.git.getRef({
    owner,
    repo: projectName,
    ref: `heads/${branch}`,
  });
  const commit = await octokit.git.getCommit({
    owner,
    repo: projectName,
    commit_sha: ref.data.object.sha,
  });
  const tree = await octokit.git.getTree({
    owner,
    repo: projectName,
    tree_sha: commit.data.tree.sha,
    recursive: "true",
  });
  if (tree.data.truncated)
    throw new Error(
      `Repository ${owner}/${projectName} is too large to inspect safely.`,
    );
  const paths = new Set(
    (tree.data.tree ?? [])
      .map((entry) => entry.path)
      .filter((path): path is string => Boolean(path)),
  );
  let manifest: string | undefined;
  if (paths.has("nextjs-app.yml"))
    manifest = await readRepositoryFile(
      octokit,
      projectName,
      "nextjs-app.yml",
      branch,
    );

  return {
    exists: true,
    htmlUrl: repository.data.html_url,
    branch,
    headSha: ref.data.object.sha,
    treeSha: commit.data.tree.sha,
    paths,
    manifest,
  };
}

export async function commitProjectFiles(
  token: string,
  projectName: string,
  snapshot: RepositorySnapshot,
  files: Record<string, string>,
): Promise<RepositoryCommitResult> {
  const octokit = new Octokit({ auth: token });
  let repositoryUrl = snapshot.htmlUrl;
  let branch = snapshot.branch;
  if (!snapshot.exists) {
    const created = await octokit.repos.createInOrg({
      org: owner,
      name: projectName,
      private: true,
      description: "Next.js project provisioned by account-factory",
      has_issues: true,
      has_projects: false,
      has_wiki: false,
      auto_init: false,
    });
    repositoryUrl = created.data.html_url;
    branch = "main";
    const tree = await octokit.git.createTree({
      owner,
      repo: projectName,
      tree: Object.entries(files).map(([path, content]) => ({
        path,
        mode: "100644" as const,
        type: "blob" as const,
        content,
      })),
    });
    const commit = await octokit.git.createCommit({
      owner,
      repo: projectName,
      message: "Initialize project and AWS integration",
      tree: tree.data.sha,
      parents: [],
    });
    await octokit.git.createRef({
      owner,
      repo: projectName,
      ref: "refs/heads/main",
      sha: commit.data.sha,
    });
    await octokit.repos.update({
      owner,
      repo: projectName,
      default_branch: "main",
    });
    return {
      repositoryUrl: repositoryUrl ?? created.data.html_url,
      branch,
      commitSha: commit.data.sha,
    };
  }

  const currentRef = await octokit.git.getRef({
    owner,
    repo: projectName,
    ref: `heads/${branch}`,
  });
  if (snapshot.exists && currentRef.data.object.sha !== snapshot.headSha) {
    throw new Error(
      `Repository ${owner}/${projectName} changed while AWS was being configured; refusing to commit over newer work.`,
    );
  }
  const parentCommit = await octokit.git.getCommit({
    owner,
    repo: projectName,
    commit_sha: currentRef.data.object.sha,
  });
  const tree = await octokit.git.createTree({
    owner,
    repo: projectName,
    base_tree: parentCommit.data.tree.sha,
    tree: Object.entries(files).map(([path, content]) => ({
      path,
      mode: "100644" as const,
      type: "blob" as const,
      content,
    })),
  });
  const commit = await octokit.git.createCommit({
    owner,
    repo: projectName,
    message: "Add account-factory AWS integration",
    tree: tree.data.sha,
    parents: [currentRef.data.object.sha],
  });
  await octokit.git.updateRef({
    owner,
    repo: projectName,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
    force: false,
  });
  return {
    repositoryUrl:
      repositoryUrl ?? `https://github.com/${owner}/${projectName}`,
    branch,
    commitSha: commit.data.sha,
  };
}

async function readRepositoryFile(
  octokit: Octokit,
  projectName: string,
  path: string,
  branch: string,
): Promise<string> {
  const response = await octokit.repos.getContent({
    owner,
    repo: projectName,
    path,
    ref: branch,
  });
  if (Array.isArray(response.data) || response.data.type !== "file")
    throw new Error(`${path} is not a regular file.`);
  return Buffer.from(response.data.content, "base64").toString("utf8");
}
