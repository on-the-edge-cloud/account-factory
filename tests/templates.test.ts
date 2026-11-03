import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  planProjectFiles,
  projectFiles,
} from "../src/templates/project-files.js";

const input = {
  projectName: "storefront",
  appType: "ssr" as const,
  awsRegion: "eu-west-1",
  nodeVersion: "22",
};

describe("generated project files", () => {
  it("generates the github-actions-nextjs application config", () => {
    const files = projectFiles(input);
    const config = parse(files["nextjs-app.yml"]);

    expect(config).toEqual({
      app: {
        slug: "storefront",
        directory: ".",
        "node-version": "22",
        "aws-region": "eu-west-1",
        "deployment-type": "ssr",
        domain: "",
      },
    });
    expect(files["sst.config.ts"]).toBeUndefined();
  });

  it("uses the shared static deployment workflow templates for both app types", () => {
    const ssrFiles = projectFiles(input);
    const staticFiles = projectFiles({ ...input, appType: "static" });

    expect(staticFiles[".github/workflows/deploy.yml"]).toBe(
      ssrFiles[".github/workflows/deploy.yml"],
    );
    expect(staticFiles[".github/workflows/preview.yml"]).toBe(
      ssrFiles[".github/workflows/preview.yml"],
    );
    expect(parse(staticFiles["nextjs-app.yml"]).app["deployment-type"]).toBe(
      "static",
    );
  });

  it("calls the shared reusable workflows with static caller definitions", () => {
    const files = projectFiles(input);
    const workflowFiles = Object.keys(files).filter((path) =>
      path.startsWith(".github/workflows/"),
    );
    const preview = parse(files[".github/workflows/preview.yml"]);
    const deploy = parse(files[".github/workflows/deploy.yml"]);
    const previewOn = preview.on ?? preview["on"];
    const deployOn = deploy.on ?? deploy["on"];

    expect(workflowFiles).toEqual([
      ".github/workflows/preview.yml",
      ".github/workflows/deploy.yml",
    ]);
    expect(deployOn.push.branches).toEqual(["main"]);
    expect(deployOn.workflow_dispatch).toBeDefined();
    expect(deploy.jobs.production.uses).toBe(
      "on-the-edge-cloud/github-actions-nextjs/.github/workflows/nextjs-production.yml@v1.20",
    );
    expect(deploy.jobs.production.with["config-path"]).toBe("nextjs-app.yml");
    expect(previewOn.pull_request.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
      "closed",
    ]);
    expect(preview.jobs.preview.if).toBe(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(preview.jobs.preview.uses).toBe(
      "on-the-edge-cloud/github-actions-nextjs/.github/workflows/nextjs-preview.yml@v1.20",
    );
    expect(preview.jobs.preview.with["config-path"]).toBe("nextjs-app.yml");
    expect(preview.jobs.preview.with.command).toBe(
      "${{ github.event.action == 'closed' && 'destroy' || 'deploy' }}",
    );
    expect(preview.permissions["pull-requests"]).toBe("write");
  });

  it("preserves app-specific keys and removes unsupported root keys when merging config", () => {
    const existingManifest = [
      "service: legacy-service",
      "app:",
      "  domain: keep.example.com",
      "  custom-setting: keep-me",
      "",
    ].join("\n");
    const plan = planProjectFiles(input, {
      existing: true,
      existingPaths: new Set(["nextjs-app.yml"]),
      existingManifest,
    });
    const config = parse(plan.files["nextjs-app.yml"]);

    expect(config.service).toBeUndefined();
    expect(config.app["custom-setting"]).toBe("keep-me");
    expect(config.app.domain).toBe("keep.example.com");
    expect(config.app["deployment-type"]).toBe("ssr");
  });

  it("replaces existing standard workflow files", () => {
    const plan = planProjectFiles(input, {
      existing: true,
      existingPaths: new Set([
        ".github/workflows/preview.yml",
        ".github/workflows/deploy.yml",
      ]),
    });

    expect(plan.files[".github/workflows/preview.yml"]).toBeDefined();
    expect(plan.files[".github/workflows/deploy.yml"]).toBeDefined();
    expect(plan.updated).toEqual([
      ".github/workflows/preview.yml",
      ".github/workflows/deploy.yml",
    ]);
  });

  it("reports the GitHub auto-init README as updated for a new repository", () => {
    const plan = planProjectFiles(input);

    expect(plan.created).not.toContain("README.md");
    expect(plan.updated).toContain("README.md");
  });

  it("exposes account provisioning outputs from the manually-triggered workflow", () => {
    const workflow = parse(
      readFileSync(".github/workflows/create-project.yml", "utf8"),
    );
    expect(workflow.permissions["id-token"]).toBe("write");
    expect(workflow.jobs["create-project"].outputs.account_id).toContain(
      "steps.create-project.outputs.account_id",
    );
    expect(workflow.jobs["create-project"].outputs.status).toContain(
      "steps.create-project.outputs.status",
    );
    expect(workflow.jobs["create-project"].outputs.files_created).toContain(
      "steps.create-project.outputs.files_created",
    );
    expect(workflow.jobs["create-project"].outputs.build_validation).toContain(
      "steps.create-project.outputs.build_validation",
    );
    expect(workflow.jobs["create-project"].if).toBe(
      "github.ref == 'refs/heads/main'",
    );
    expect(workflow.on.workflow_dispatch.inputs.aws_region.required).toBe(
      false,
    );
  });
});
