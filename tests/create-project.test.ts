import { describe, expect, it, vi } from "vitest";
import type { CreateProjectDependencies } from "../src/services/create-project.js";
import { createProject } from "../src/services/create-project.js";

describe("project provisioning order", () => {
  it("aborts an existing repository build failure before creating an AWS account", async () => {
    const createAccount = vi.fn();
    const dependencies = {
      inspectRepository: vi.fn().mockResolvedValue({
        exists: true,
        htmlUrl: "https://github.com/on-the-edge-cloud/demo",
        branch: "main",
        headSha: "head",
        treeSha: "tree",
        paths: new Set(["package.json", "yarn.lock"]),
      }),
      validateExisting: vi.fn().mockRejectedValue(new Error("build failed")),
      validateNew: vi.fn(),
      createAccount,
      configureRoles: vi.fn(),
      commitFiles: vi.fn(),
    } as unknown as CreateProjectDependencies;

    await expect(createProject({
      projectName: "demo",
      appType: "ssr",
      awsRegion: "eu-west-1",
      nodeVersion: "22",
    }, "token", dependencies)).rejects.toThrow("build failed");
    expect(createAccount).not.toHaveBeenCalled();
    expect(dependencies.configureRoles).not.toHaveBeenCalled();
    expect(dependencies.commitFiles).not.toHaveBeenCalled();
  });
});