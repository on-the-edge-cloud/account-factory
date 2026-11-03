import { beforeEach, describe, expect, it, vi } from "vitest";
import sodium from "libsodium-wrappers";

const githubApi = vi.hoisted(() => ({
  actions: {
    getRepoPublicKey: vi.fn(),
    getEnvironmentPublicKey: vi.fn(),
    createOrUpdateRepoSecret: vi.fn(),
    createOrUpdateEnvironmentSecret: vi.fn(),
  },
  repos: {
    createOrUpdateEnvironment: vi.fn(),
    listDeploymentBranchPolicies: vi.fn(),
    deleteDeploymentBranchPolicy: vi.fn(),
    createDeploymentBranchPolicy: vi.fn(),
  },
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    actions = githubApi.actions;
    repos = githubApi.repos;
  },
}));

import { configureProjectRepository } from "../src/clients/github.js";

describe("configureProjectRepository", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    githubApi.repos.listDeploymentBranchPolicies.mockResolvedValue({
      data: { branch_policies: [{ id: 12 }] },
    });
    githubApi.actions.createOrUpdateRepoSecret.mockResolvedValue({});
    githubApi.actions.createOrUpdateEnvironmentSecret.mockResolvedValue({});
    githubApi.repos.createOrUpdateEnvironment.mockResolvedValue({});
    githubApi.repos.deleteDeploymentBranchPolicy.mockResolvedValue({});
    githubApi.repos.createDeploymentBranchPolicy.mockResolvedValue({});
  });

  it("restricts production to main and sets encrypted repository/environment secrets", async () => {
    await sodium.ready;
    const repositoryKey = sodium.crypto_box_keypair();
    const environmentKey = sodium.crypto_box_keypair();
    githubApi.actions.getRepoPublicKey.mockResolvedValue({
      data: {
        key: sodium.to_base64(
          repositoryKey.publicKey,
          sodium.base64_variants.ORIGINAL,
        ),
        key_id: "repository-key",
      },
    });
    githubApi.actions.getEnvironmentPublicKey.mockResolvedValue({
      data: {
        key: sodium.to_base64(
          environmentKey.publicKey,
          sodium.base64_variants.ORIGINAL,
        ),
        key_id: "environment-key",
      },
    });

    await configureProjectRepository("token", "demo", {
      previewRoleArn: "arn:aws:iam::123456789012:role/preview",
      productionRoleArn: "arn:aws:iam::123456789012:role/production",
      cloudflareApiToken: "cloudflare-secret",
    });

    expect(githubApi.repos.createOrUpdateEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        environment_name: "production",
        reviewers: [],
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: true,
        },
      }),
    );
    expect(githubApi.repos.deleteDeploymentBranchPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ branch_policy_id: 12 }),
    );
    expect(githubApi.repos.createDeploymentBranchPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "main", type: "branch" }),
    );

    const repositorySecret =
      githubApi.actions.createOrUpdateRepoSecret.mock.calls[0][0];
    expect(repositorySecret.secret_name).toBe("AWS_ROLE_ARN");
    expect(
      sodium.to_string(
        sodium.crypto_box_seal_open(
          sodium.from_base64(
            repositorySecret.encrypted_value,
            sodium.base64_variants.ORIGINAL,
          ),
          repositoryKey.publicKey,
          repositoryKey.privateKey,
        ),
      ),
    ).toBe("arn:aws:iam::123456789012:role/preview");

    const environmentSecrets =
      githubApi.actions.createOrUpdateEnvironmentSecret.mock.calls;
    expect(environmentSecrets).toHaveLength(2);
    const decryptedEnvironmentSecrets = environmentSecrets.map(([secret]) => {
      const plaintext = sodium.crypto_box_seal_open(
        sodium.from_base64(
          secret.encrypted_value,
          sodium.base64_variants.ORIGINAL,
        ),
        environmentKey.publicKey,
        environmentKey.privateKey,
      );
      return [secret.secret_name, sodium.to_string(plaintext)];
    });
    expect(decryptedEnvironmentSecrets).toEqual([
      ["AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/production"],
      ["CLOUDFLARE_API_TOKEN", "cloudflare-secret"],
    ]);
  });

  it("does not create a Cloudflare secret when no custom-domain token is supplied", async () => {
    await sodium.ready;
    const repositoryKey = sodium.crypto_box_keypair();
    const environmentKey = sodium.crypto_box_keypair();
    githubApi.actions.getRepoPublicKey.mockResolvedValue({
      data: {
        key: sodium.to_base64(
          repositoryKey.publicKey,
          sodium.base64_variants.ORIGINAL,
        ),
        key_id: "repository-key",
      },
    });
    githubApi.actions.getEnvironmentPublicKey.mockResolvedValue({
      data: {
        key: sodium.to_base64(
          environmentKey.publicKey,
          sodium.base64_variants.ORIGINAL,
        ),
        key_id: "environment-key",
      },
    });

    await configureProjectRepository("token", "demo", {
      previewRoleArn: "preview",
      productionRoleArn: "production",
    });

    expect(
      githubApi.actions.createOrUpdateEnvironmentSecret,
    ).toHaveBeenCalledTimes(1);
    expect(
      githubApi.actions.createOrUpdateEnvironmentSecret.mock.calls[0][0]
        .secret_name,
    ).toBe("AWS_ROLE_ARN");
  });
});
