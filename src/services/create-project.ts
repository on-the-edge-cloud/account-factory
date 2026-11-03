import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { STSClient } from "@aws-sdk/client-sts";
import { createAccount, type AccountResult } from "../clients/organizations.js";
import { configureProjectRoles, type RoleNames } from "../clients/iam.js";
import {
  commitProjectFiles,
  configureProjectRepository,
  inspectProjectRepository,
  type RepositoryCommitResult,
  type RepositorySnapshot,
  type ProjectRepositorySecrets,
} from "../clients/github.js";
import {
  accountEmail,
  validateProjectInput,
  type ProjectInput,
} from "../validation.js";
import {
  planProjectFiles,
  type ProjectFileOptions,
  type ProjectFilePlan,
} from "../templates/project-files.js";
import {
  validateExistingProject,
  validateNewProject,
  type ExistingProjectBuildInfo,
} from "./project-validation.js";

export interface CreateProjectDependencies {
  inspectRepository: typeof inspectProjectRepository;
  validateExisting: typeof validateExistingProject;
  validateNew: typeof validateNewProject;
  createAccount: (
    client: OrganizationsClient,
    projectName: string,
    email: string,
  ) => Promise<AccountResult>;
  configureRoles: typeof configureProjectRoles;
  commitFiles: typeof commitProjectFiles;
  configureRepository: typeof configureProjectRepository;
}

export interface ProjectCredentials {
  githubToken: string;
  cloudflareApiToken?: string;
}

const defaultDependencies: CreateProjectDependencies = {
  inspectRepository: inspectProjectRepository,
  validateExisting: validateExistingProject,
  validateNew: validateNewProject,
  createAccount,
  configureRoles: configureProjectRoles,
  commitFiles: commitProjectFiles,
  configureRepository: configureProjectRepository,
};

export async function createProject(
  input: ProjectInput,
  credentials: ProjectCredentials,
  dependencies: CreateProjectDependencies = defaultDependencies,
) {
  validateProjectInput(input);
  if (input.customDomain && !credentials.cloudflareApiToken) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN is required when a custom domain is configured.",
    );
  }
  const { githubToken } = credentials;
  let repository: RepositorySnapshot;
  let buildInfo: ExistingProjectBuildInfo;
  let fileOptions: ProjectFileOptions;
  let plan: ProjectFilePlan;
  const restoreCredentials = suspendWorkflowCredentials();
  try {
    repository = await dependencies.inspectRepository(
      githubToken,
      input.projectName,
    );
    buildInfo = repository.exists
      ? await dependencies.validateExisting(
          repository.htmlUrl!,
          repository.branch,
          input.projectName,
          githubToken,
        )
      : await dependencies.validateNew(input);
    fileOptions = {
      existing: repository.exists,
      existingPaths: repository.paths,
      existingManifest: repository.manifest,
      applicationFiles: buildInfo.applicationFiles,
    };
    plan = planProjectFiles(input, fileOptions);
  } finally {
    restoreCredentials();
  }

  const organizations = new OrganizationsClient({ region: input.awsRegion });
  const sts = new STSClient({ region: input.awsRegion });
  const email = accountEmail(input.projectName);
  const account = await dependencies.createAccount(
    organizations,
    input.projectName,
    email,
  );
  const roles: RoleNames = await dependencies.configureRoles(
    sts,
    account.accountId,
    input.projectName,
    input.appType,
    input.customDomain,
  );
  if (!repository.exists) {
    plan.files["yarn.lock"] = buildInfo.yarnLock;
    plan.created.push("yarn.lock");
  }
  const committed: RepositoryCommitResult = await dependencies.commitFiles(
    githubToken,
    input.projectName,
    repository,
    plan.files,
  );
  const repositorySecrets: ProjectRepositorySecrets = {
    previewRoleArn: `arn:aws:iam::${account.accountId}:role/${roles.preview}`,
    productionRoleArn: `arn:aws:iam::${account.accountId}:role/${roles.production}`,
    ...(input.customDomain
      ? { cloudflareApiToken: credentials.cloudflareApiToken }
      : {}),
  };
  await dependencies.configureRepository(
    githubToken,
    input.projectName,
    repositorySecrets,
  );
  return {
    accountId: account.accountId,
    rootEmail: email,
    previewRoleArn: repositorySecrets.previewRoleArn,
    productionRoleArn: repositorySecrets.productionRoleArn,
    repositoryUrl: committed.repositoryUrl,
    filesCreated: plan.created,
    filesUpdated: plan.updated,
    buildValidation: "PASSED",
    status: "SUCCEEDED",
  };
}

function suspendWorkflowCredentials(): () => void {
  const saved: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("AWS_") ||
      key.startsWith("ACTIONS_") ||
      key === "GITHUB_TOKEN" ||
      key === "GH_TOKEN" ||
      key === "ACCOUNT_FACTORY_GITHUB_TOKEN" ||
      key === "CLOUDFLARE_API_TOKEN"
    ) {
      const value = process.env[key];
      if (value !== undefined) saved[key] = value;
      delete process.env[key];
    }
  }
  return () => {
    Object.assign(process.env, saved);
  };
}
