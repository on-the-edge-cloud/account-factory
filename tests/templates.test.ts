import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { roleNames } from "../src/clients/iam.js";
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
  it("includes the deployment workflows, descriptor, and SST app", () => {
    const files = projectFiles(
      input,
      "123456789012",
      roleNames(input.projectName),
    );
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        ".github/workflows/preview.yml",
        ".github/workflows/deploy.yml",
        "nextjs-app.yml",
        "sst.config.ts",
      ]),
    );
    const config = parse(files["nextjs-app.yml"]);
    expect(config.app["aws-region"]).toBe("eu-west-1");
    expect(config.app["deployment-type"]).toBe("ssr");
    expect(config.app["deployment-strategy"]).toBe(
      "cloudfront-api-gateway-lambda",
    );
    expect(config.app.domain).toBeNull();
    expect(config.app["domain-provider"]).toBeNull();
    expect(files["sst.config.ts"]).toContain("sst.aws.Nextjs");
    expect(files["sst.config.ts"]).toContain(
      'permissionsBoundary: "arn:aws:iam::123456789012:policy/storefront-runtime-boundary"',
    );
    expect(files[".github/workflows/deploy.yml"]).toContain(
      'app.fetch("production-role-arn")',
    );
  });

  it("generates static hosting without adding app resources to the factory", () => {
    const files = projectFiles(
      { ...input, appType: "static" },
      "123456789012",
      roleNames(input.projectName),
    );
    expect(files["sst.config.ts"]).toContain("sst.aws.StaticSite");
    expect(files[".github/workflows/preview.yml"]).toContain(
      'commands["preview-deploy"]',
    );
    expect(files["next.config.ts"]).toContain('output: "export"');
    expect(files[".github/workflows/preview.yml"]).toContain(
      'app.fetch("aws-region")',
    );
    expect(files[".github/workflows/preview.yml"]).toContain(
      "steps.app-config.outputs.deployment_strategy",
    );
    expect(files[".github/workflows/preview.yml"]).toContain(
      "typecheck_command",
    );
    expect(files[".github/workflows/preview.yml"]).not.toContain(
      "environment: preview",
    );
  });

  it("adds ACM and Route 53 metadata when a domain is configured", () => {
    const files = projectFiles(
      { ...input, customDomain: "app.example.com" },
      "123456789012",
      roleNames(input.projectName),
    );
    const config = parse(files["nextjs-app.yml"]);
    expect(config.app.domain).toBe("app.example.com");
    expect(config.app["domain-provider"]).toEqual({
      certificate: "acm",
      dns: "route53",
    });
  });

  it("preserves unknown keys when merging an existing manifest", () => {
    const existingManifest = [
      "service: legacy-service",
      "app:",
      "  domain: keep.example.com",
      "  custom-setting: keep-me",
      "  commands:",
      "    custom-deploy: deploy.sh",
      "",
    ].join("\n");
    const plan = planProjectFiles(
      input,
      "123456789012",
      roleNames(input.projectName),
      {
        existing: true,
        existingPaths: new Set(["nextjs-app.yml"]),
        existingManifest,
        packageManager: "npm",
        installCommand: "npm install",
        scripts: { build: "next build" },
        previewDeployCommand: "npm run deploy:preview",
        productionDeployCommand: "npm run deploy:production",
      },
    );
    const config = parse(plan.files["nextjs-app.yml"]);
    expect(config.service).toBe("legacy-service");
    expect(config.app["custom-setting"]).toBe("keep-me");
    expect(config.app.domain).toBe("keep.example.com");
    expect(config.app["domain-provider"]).toEqual({ certificate: "acm", dns: "route53" });
    expect(config.app.commands["custom-deploy"]).toBe("deploy.sh");
  });

  it("restricts production deployments to main", () => {
    const files = projectFiles(
      input,
      "123456789012",
      roleNames(input.projectName),
    );
    expect(files[".github/workflows/deploy.yml"]).toContain("branches: [main]");
    expect(files[".github/workflows/preview.yml"]).toContain("pull_request:");
    expect(files["sst.config.ts"]).toContain(
      'process.env.STAGE === "production"',
    );
  });

  it("produces valid workflows and passes the preview stage to deployment and cleanup", () => {
    const files = projectFiles(
      input,
      "123456789012",
      roleNames(input.projectName),
    );
    const preview = parse(files[".github/workflows/preview.yml"]);
    const deploy = parse(files[".github/workflows/deploy.yml"]);
    const previewOn = preview.on ?? preview["on"];
    const deployOn = deploy.on ?? deploy["on"];
    expect(previewOn.pull_request.branches).toContain("main");
    expect(previewOn.workflow_dispatch).toBeDefined();
    expect(preview.jobs.deploy.environment).toBeUndefined();
    expect(deployOn.push.branches).toContain("main");
    expect(deploy.jobs.deploy.environment).toBe("production");
    expect(
      preview.jobs.deploy.steps.some((step: { run?: string }) =>
        step.run?.includes("APP_COMMAND"),
      ),
    ).toBe(true);
    expect(
      preview.jobs.deploy.steps.some(
        (step: { id?: string }) => step.id === "app-config",
      ),
    ).toBe(true);
  });

  it("preserves conflicting workflows and only plans files missing from an existing repo", () => {
    const plan = planProjectFiles(
      input,
      "123456789012",
      roleNames(input.projectName),
      {
        existing: true,
        existingPaths: new Set([
          ".github/workflows/preview.yml",
          "package.json",
          "src/app/page.tsx",
        ]),
        packageManager: "npm",
        scripts: { build: "next build" },
      },
    );
    expect(plan.files[".github/workflows/aws-preview.yml"]).toBeDefined();
    expect(plan.files[".github/workflows/preview.yml"]).toBeUndefined();
    expect(plan.files["package.json"]).toBeUndefined();
    expect(plan.files["src/app/page.tsx"]).toBeUndefined();
    expect(plan.ignored).toContain(".github/workflows/preview.yml");
  });

  it("reports the GitHub auto-init README as updated for a new repository", () => {
    const plan = planProjectFiles(input, "123456789012", roleNames(input.projectName));
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
