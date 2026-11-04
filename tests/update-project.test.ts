import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  updateProject,
  type UpdateProjectDependencies,
} from "../src/services/update-project.js";
import type { RepositorySnapshot } from "../src/clients/github.js";

const manifest = `# Existing project
app:
  slug: storefront
  directory: web
  node-version: "22"
  aws-region: eu-north-1
  deployment-type: static # Deployment mode
  domain: app.example.com
  extra-setting: keep
other: keep
`;
const input = {
  projectName: "storefront",
  accountId: "123456789012",
  appType: "ssr" as const,
};

function setup(manifestContent = manifest) {
  const repository: RepositorySnapshot = {
    exists: true,
    htmlUrl: "https://github.com/on-the-edge-cloud/storefront",
    branch: "main",
    headSha: "head",
    treeSha: "tree",
    paths: new Set(["nextjs-app.yml", "next.config.ts", "package.json"]),
    manifest: manifestContent,
  };
  const dependencies = {
    inspectRepository: vi.fn().mockResolvedValue(repository),
    updateRoles: vi.fn().mockResolvedValue({
      preview: "github-actions-storefront-preview",
      production: "github-actions-storefront-production",
    }),
    commitFiles: vi.fn().mockResolvedValue({
      repositoryUrl: repository.htmlUrl,
      branch: "main",
      commitSha: "updated",
    }),
  } satisfies UpdateProjectDependencies;
  return { repository, dependencies };
}

describe("updateProject", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates both role policies before committing only the manifest type", async () => {
    const { repository, dependencies } = setup();
    const result = await updateProject(input, "token", dependencies);

    expect(dependencies.updateRoles).toHaveBeenCalledWith(
      expect.anything(),
      input.accountId,
      "storefront",
      "ssr",
      "app.example.com",
    );
    expect(dependencies.updateRoles.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.commitFiles.mock.invocationCallOrder[0],
    );
    const [token, projectName, snapshot, files] =
      dependencies.commitFiles.mock.calls[0];
    expect([token, projectName, snapshot]).toEqual([
      "token",
      "storefront",
      repository,
    ]);
    expect(Object.keys(files)).toEqual(["nextjs-app.yml"]);
    const expected = parse(manifest);
    expected.app["deployment-type"] = "ssr";
    expect(parse(files["nextjs-app.yml"])).toEqual(expected);
    expect(files["nextjs-app.yml"]).toContain("# Existing project");
    expect(files["nextjs-app.yml"]).toContain("# Deployment mode");
    expect(result).toMatchObject({
      accountId: input.accountId,
      previousType: "static",
      appType: "ssr",
      manifestUpdated: true,
      status: "SUCCEEDED",
    });
    expect(result.warning).toMatch(/NOT destroyed or migrated/);
  });

  it("refreshes policies without a commit if the manifest already says SSR", async () => {
    const { dependencies } = setup(
      manifest.replace("deployment-type: static", "deployment-type: ssr"),
    );
    const result = await updateProject(input, "token", dependencies);
    expect(dependencies.updateRoles).toHaveBeenCalledOnce();
    expect(dependencies.commitFiles).not.toHaveBeenCalled();
    expect(result.manifestUpdated).toBe(false);
  });

  it("can switch to static without losing the existing region or domain", async () => {
    const { dependencies } = setup(
      manifest
        .replace("deployment-type: static", "deployment-type: ssr")
        .replace("eu-north-1", "eu-central-1"),
    );
    await updateProject({ ...input, appType: "static" }, "token", dependencies);
    expect(dependencies.updateRoles).toHaveBeenCalledWith(
      expect.anything(),
      input.accountId,
      input.projectName,
      "static",
      "app.example.com",
    );
    const files = dependencies.commitFiles.mock.calls[0][3];
    expect(parse(files["nextjs-app.yml"]).app["aws-region"]).toBe(
      "eu-central-1",
    );
    expect(parse(files["nextjs-app.yml"]).app["deployment-type"]).toBe(
      "static",
    );
  });

  it("does not commit when a role update fails", async () => {
    const { dependencies } = setup();
    dependencies.updateRoles.mockRejectedValue(new Error("AccessDenied"));
    await expect(updateProject(input, "token", dependencies)).rejects.toThrow(
      "AccessDenied",
    );
    expect(dependencies.commitFiles).not.toHaveBeenCalled();
  });

  it("surfaces commit failures after IAM updates without claiming success", async () => {
    const { dependencies } = setup();
    dependencies.commitFiles.mockRejectedValue(new Error("newer work"));
    await expect(updateProject(input, "token", dependencies)).rejects.toThrow(
      "newer work",
    );
    expect(dependencies.updateRoles).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing repository", { exists: false }],
    ["missing manifest", { manifest: undefined }],
    ["non-main branch", { branch: "develop" }],
    ["invalid YAML", { manifest: "app: [" }],
    ["invalid app", { manifest: "app: []" }],
    ["mismatched slug", { manifest: manifest.replace("storefront", "other") }],
    ["invalid region", { manifest: manifest.replace("eu-north-1", "invalid") }],
    [
      "invalid domain",
      { manifest: manifest.replace("app.example.com", "bad") },
    ],
  ])("rejects %s before modifying IAM or GitHub", async (_name, overrides) => {
    const { repository, dependencies } = setup();
    Object.assign(repository, overrides);
    await expect(updateProject(input, "token", dependencies)).rejects.toThrow();
    expect(dependencies.updateRoles).not.toHaveBeenCalled();
    expect(dependencies.commitFiles).not.toHaveBeenCalled();
  });

  it.each(["", "123", "123456789012\n"])(
    "rejects malformed account ID %j before inspecting the repository",
    async (accountId) => {
      const { dependencies } = setup();
      await expect(
        updateProject({ ...input, accountId }, "token", dependencies),
      ).rejects.toThrow();
      expect(dependencies.inspectRepository).not.toHaveBeenCalled();
    },
  );
});

describe("Update project workflow", () => {
  it("runs on main using the existing bootstrap role and App token", () => {
    const workflow = parse(
      readFileSync(".github/workflows/update-project.yml", "utf8"),
    );
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual([
      "project_name",
      "account_id",
      "app_type",
    ]);
    expect(workflow.jobs["update-project"].if).toBe(
      "github.ref == 'refs/heads/main'",
    );
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    const steps = workflow.jobs["update-project"].steps;
    expect(
      steps.find((step: { uses?: string }) =>
        step.uses?.startsWith("aws-actions/"),
      ).with["role-to-assume"],
    ).toBe("${{ vars.AWS_ACCOUNT_FACTORY_ROLE_ARN }}");
    expect(steps.at(-1)).toMatchObject({
      run: "yarn update-project",
      env: {
        ACCOUNT_ID: "${{ inputs.account_id }}",
        ACCOUNT_FACTORY_GITHUB_TOKEN: "${{ steps.app-token.outputs.token }}",
      },
    });
  });
});
