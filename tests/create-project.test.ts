import { describe, expect, it, vi } from "vitest";
import type { CreateProjectDependencies } from "../src/services/create-project.js";
import { createProject } from "../src/services/create-project.js";

describe("project provisioning order", () => {
  it("aborts an existing repository build failure before creating an AWS account", async () => {
    const createAccount = vi.fn();
    const priorEnvironment = {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      ACCOUNT_FACTORY_GITHUB_TOKEN: process.env.ACCOUNT_FACTORY_GITHUB_TOKEN,
    };
    process.env.AWS_ACCESS_KEY_ID = "test-access-key";
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "test-oidc-token";
    process.env.ACCOUNT_FACTORY_GITHUB_TOKEN = "test-github-token";
    const dependencies = {
      inspectRepository: vi.fn().mockImplementation(async () => {
        expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
        expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
        expect(process.env.ACCOUNT_FACTORY_GITHUB_TOKEN).toBeUndefined();
        return {
          exists: true,
          htmlUrl: "https://github.com/on-the-edge-cloud/demo",
          branch: "main",
          headSha: "head",
          treeSha: "tree",
          paths: new Set(["package.json", "yarn.lock"]),
        };
      }),
      validateExisting: vi.fn().mockImplementation(async () => {
        expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
        expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
        expect(process.env.ACCOUNT_FACTORY_GITHUB_TOKEN).toBeUndefined();
        throw new Error("build failed");
      }),
      validateNew: vi.fn(),
      createAccount,
      configureRoles: vi.fn(),
      commitFiles: vi.fn(),
    } as unknown as CreateProjectDependencies;

    try {
      await expect(
        createProject(
          {
            projectName: "demo",
            appType: "ssr",
            awsRegion: "eu-west-1",
            nodeVersion: "22",
          },
          "test-github-token",
          dependencies,
        ),
      ).rejects.toThrow("build failed");
      expect(createAccount).not.toHaveBeenCalled();
      expect(dependencies.configureRoles).not.toHaveBeenCalled();
      expect(dependencies.commitFiles).not.toHaveBeenCalled();
      expect(process.env.AWS_ACCESS_KEY_ID).toBe("test-access-key");
      expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe("test-oidc-token");
      expect(process.env.ACCOUNT_FACTORY_GITHUB_TOKEN).toBe("test-github-token");
    } finally {
      for (const [key, value] of Object.entries(priorEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
