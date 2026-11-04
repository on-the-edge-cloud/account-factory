import { STSClient } from "@aws-sdk/client-sts";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  commitProjectFiles,
  inspectProjectRepository,
} from "../clients/github.js";
import { roleNames, updateProjectRoles } from "../clients/iam.js";
import { validateProjectInput, type AppType } from "../validation.js";

export interface UpdateProjectInput {
  projectName: string;
  accountId: string;
  appType: AppType;
}

export interface UpdateProjectDependencies {
  inspectRepository: typeof inspectProjectRepository;
  updateRoles: typeof updateProjectRoles;
  commitFiles: typeof commitProjectFiles;
}

const defaultDependencies: UpdateProjectDependencies = {
  inspectRepository: inspectProjectRepository,
  updateRoles: updateProjectRoles,
  commitFiles: commitProjectFiles,
};

const manifestSchema = z.object({
  app: z.object({
    slug: z.string(),
    "aws-region": z.string(),
    "node-version": z.union([z.string(), z.number()]),
    "deployment-type": z.enum(["static", "ssr"]),
    domain: z.string().optional(),
  }),
});

export const updateProjectWarning =
  "Terraform states for static and SSR are separate. Previous production and preview resources are NOT destroyed or migrated and may continue generating costs. Custom domains may conflict with the previous distribution. Application files and Next.js configuration are not changed: remove output: 'export' to enable SSR features, or configure static export before deploying static. Switching to static removes SSR deployment permissions; cleanup of old SSR resources requires an administrative role. Existing PR branches keep their own manifest until updated. Stop concurrent deployments before running this update.";

export async function updateProject(
  input: UpdateProjectInput,
  githubToken: string,
  dependencies: UpdateProjectDependencies = defaultDependencies,
) {
  z.string()
    .length(12)
    .regex(/^\d{12}$/)
    .parse(input.accountId);
  validateProjectInput({
    projectName: input.projectName,
    appType: input.appType,
  });
  roleNames(input.projectName);
  const repository = await dependencies.inspectRepository(
    githubToken,
    input.projectName,
  );
  if (!repository.exists || !repository.manifest) {
    throw new Error("An existing repository with nextjs-app.yml is required.");
  }
  if (repository.branch !== "main") {
    throw new Error("The project default branch must be main.");
  }
  const manifest = parseDocument(repository.manifest);
  if (manifest.errors.length) {
    throw new Error(`nextjs-app.yml is invalid: ${manifest.errors[0].message}`);
  }
  const { app } = manifestSchema.parse(manifest.toJS());
  const project = validateProjectInput({
    projectName: input.projectName,
    appType: input.appType,
    awsRegion: app["aws-region"],
    nodeVersion: String(app["node-version"]),
    customDomain: app.domain || undefined,
  });
  const expectedSlug = input.projectName.slice(0, 24).replace(/-+$/g, "");
  if (app.slug !== expectedSlug) {
    throw new Error(
      `Manifest slug must be ${expectedSlug} to match the deployment policy resource names.`,
    );
  }
  manifest.setIn(["app", "deployment-type"], input.appType);
  await dependencies.updateRoles(
    new STSClient({ region: project.awsRegion }),
    input.accountId,
    input.projectName,
    input.appType,
    project.customDomain,
  );
  // IAM is updated first so the commit-triggered deployment has its permissions.
  const committed =
    app["deployment-type"] !== input.appType
      ? await dependencies.commitFiles(
          githubToken,
          input.projectName,
          repository,
          { "nextjs-app.yml": manifest.toString() },
        )
      : undefined;
  return {
    accountId: input.accountId,
    previousType: app["deployment-type"],
    appType: input.appType,
    repositoryUrl: committed?.repositoryUrl ?? repository.htmlUrl,
    manifestUpdated: Boolean(committed),
    warning: updateProjectWarning,
    status: "SUCCEEDED",
  };
}
