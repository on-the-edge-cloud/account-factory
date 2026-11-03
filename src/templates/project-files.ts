import { parseDocument, stringify } from "yaml";
import type { ProjectInput } from "../validation.js";

export interface ProjectFileOptions {
  existing?: boolean;
  existingPaths?: ReadonlySet<string>;
  existingManifest?: string;
  applicationFiles?: Record<string, string>;
}

export interface ProjectFilePlan {
  files: Record<string, string>;
  created: string[];
  updated: string[];
}

export function projectManifest(
  input: ProjectInput,
  options: ProjectFileOptions = {},
): string {
  const existingDocument = options.existingManifest
    ? parseDocument(options.existingManifest)
    : undefined;
  if (existingDocument?.errors.length) {
    throw new Error(
      `nextjs-app.yml is invalid: ${existingDocument.errors[0].message}`,
    );
  }
  const priorDomain = existingDocument?.getIn(["app", "domain"]);
  const app: Record<string, unknown> = {
    slug: input.projectName.toLowerCase().slice(0, 24).replace(/-+$/g, ""),
    directory: ".",
    "node-version": input.nodeVersion,
    "aws-region": input.awsRegion,
    "deployment-type": input.appType,
    domain: input.customDomain ?? priorDomain ?? "",
  };

  if (!existingDocument) return stringify({ app }, { lineWidth: 0 });

  const existingConfig = existingDocument.toJS() as Record<string, unknown>;
  for (const key of Object.keys(existingConfig))
    if (key !== "app") existingDocument.delete(key);
  const existingApp = existingConfig.app;
  if (
    existingApp !== undefined &&
    (!existingApp ||
      typeof existingApp !== "object" ||
      Array.isArray(existingApp))
  ) {
    throw new Error("nextjs-app.yml app must be a mapping.");
  }
  existingDocument.set("app", {
    ...((existingApp as Record<string, unknown> | undefined) ?? {}),
    ...app,
  });
  return existingDocument.toString();
}

export function planProjectFiles(
  input: ProjectInput,
  options: ProjectFileOptions = {},
): ProjectFilePlan {
  const existingPaths = options.existingPaths ?? new Set<string>();
  const files: Record<string, string> = {
    ".github/workflows/preview.yml": previewWorkflow,
    ".github/workflows/deploy.yml": productionWorkflow,
    "nextjs-app.yml": projectManifest(input, options),
  };
  if (!options.existing) Object.assign(files, options.applicationFiles);

  const created = Object.keys(files).filter(
    (path) =>
      !existingPaths.has(path) && (options.existing || path !== "README.md"),
  );
  const updated = options.existing
    ? Object.keys(files).filter((path) => existingPaths.has(path))
    : ["README.md"];
  return { files, created, updated };
}

export function projectFiles(
  input: ProjectInput,
  options: ProjectFileOptions = {},
): Record<string, string> {
  return planProjectFiles(input, options).files;
}

const productionWorkflow = `name: Production environment

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  production:
    uses: on-the-edge-cloud/github-actions-nextjs/.github/workflows/nextjs-production.yml@v1.13
    with:
      config-path: nextjs-app.yml
    secrets: inherit
`;

const previewWorkflow = `name: Preview environment

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

permissions:
  id-token: write
  contents: read
  pull-requests: write

jobs:
  preview:
    if: github.event.pull_request.head.repo.full_name == github.repository
    uses: on-the-edge-cloud/github-actions-nextjs/.github/workflows/nextjs-preview.yml@v1.13
    with:
      config-path: nextjs-app.yml
      command: \${{ github.event.action == 'closed' && 'destroy' || 'deploy' }}
    secrets: inherit
`;
