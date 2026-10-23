import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { STSClient } from "@aws-sdk/client-sts";
import { createAccount, type AccountResult } from "../clients/organizations.js";
import {
  configureProjectRoles,
  roleNames,
  type RoleNames,
} from "../clients/iam.js";
import {
  commitProjectFiles,
  inspectProjectRepository,
  type RepositoryCommitResult,
  type RepositorySnapshot,
} from "../clients/github.js";
import {
  accountEmail,
  validateProjectInput,
  type ProjectInput,
} from "../validation.js";
import {
  planProjectFiles,
  type ProjectFileOptions,
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
}

const defaultDependencies: CreateProjectDependencies = {
  inspectRepository: inspectProjectRepository,
  validateExisting: validateExistingProject,
  validateNew: validateNewProject,
  createAccount,
  configureRoles: configureProjectRoles,
  commitFiles: commitProjectFiles,
};

export async function createProject(
  input: ProjectInput,
  githubToken: string,
  dependencies: CreateProjectDependencies = defaultDependencies,
) {
  validateProjectInput(input);
  const names = roleNames(input.projectName);
  let repository: RepositorySnapshot;
  let buildInfo: ExistingProjectBuildInfo;
  let fileOptions: ProjectFileOptions;
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
      packageManager: buildInfo.packageManager,
      installCommand: buildInfo.installCommand,
      scripts: buildInfo.scripts,
      previewDeployCommand: buildInfo.previewDeployCommand,
      productionDeployCommand: buildInfo.productionDeployCommand,
      previewRemoveCommand: buildInfo.previewRemoveCommand,
      branch: repository.branch,
    };
    planProjectFiles(input, "000000000000", names, fileOptions);
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
  const plan = planProjectFiles(input, account.accountId, roles, fileOptions);
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
  return {
    accountId: account.accountId,
    rootEmail: email,
    previewRoleArn: `arn:aws:iam::${account.accountId}:role/${roles.preview}`,
    productionRoleArn: `arn:aws:iam::${account.accountId}:role/${roles.production}`,
    repositoryUrl: committed.repositoryUrl,
    filesCreated: plan.created,
    filesUpdated: plan.updated,
    filesIgnored: plan.ignored,
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
      key === "ACCOUNT_FACTORY_GITHUB_TOKEN"
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
