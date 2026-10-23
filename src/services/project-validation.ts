import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { projectFiles } from "../templates/project-files.js";
import { roleNames } from "../clients/iam.js";
import type { ProjectInput } from "../validation.js";
import type { PackageManager } from "../templates/project-files.js";

const execFileAsync = promisify(execFile);

export interface ExistingProjectBuildInfo {
  packageManager: PackageManager;
  installCommand: string;
  scripts: Record<string, string>;
  previewDeployCommand: string;
  productionDeployCommand: string;
  previewRemoveCommand: string;
  yarnLock: string;
}

export async function validateNewProject(
  input: ProjectInput,
): Promise<ExistingProjectBuildInfo> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "account-factory-new-"));
  try {
    const files = projectFiles(
      input,
      "123456789012",
      roleNames(input.projectName),
    );
    for (const [path, content] of Object.entries(files)) {
      const target = join(tempDirectory, path);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content);
    }
    await installDependencies("yarn", false, tempDirectory);
    for (const script of ["lint", "typecheck", "build"])
      await runScript("yarn", script, tempDirectory);
    return {
      packageManager: "yarn",
      installCommand: "corepack enable && yarn install --frozen-lockfile",
      scripts: {
        build: "yarn build",
        lint: "yarn lint",
        typecheck: "yarn typecheck",
      },
      previewDeployCommand: "yarn sst deploy --stage preview-$PR_NUMBER",
      productionDeployCommand: "yarn sst deploy --stage production",
      previewRemoveCommand: "yarn sst remove --stage preview-$PR_NUMBER",
      yarnLock: await readFile(join(tempDirectory, "yarn.lock"), "utf8"),
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export function detectPackageManager(
  packageJson: string,
  paths: ReadonlySet<string>,
): PackageManager {
  const parsed = JSON.parse(packageJson) as {
    packageManager?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const lockManagers: PackageManager[] = [];
  if (paths.has("yarn.lock")) lockManagers.push("yarn");
  if (paths.has("package-lock.json") || paths.has("npm-shrinkwrap.json"))
    lockManagers.push("npm");
  if (paths.has("pnpm-lock.yaml")) lockManagers.push("pnpm");
  if (lockManagers.length > 1)
    throw new Error(
      "Repository has multiple package-manager lockfiles; refusing to guess which one to use.",
    );

  const declared = parsed.packageManager?.split("@")[0];
  const lockManager = lockManagers[0];
  if (declared && !["yarn", "npm", "pnpm"].includes(declared)) {
    throw new Error(
      `Unsupported package manager in package.json: ${declared}.`,
    );
  }
  if (declared && lockManager && declared !== lockManager) {
    throw new Error(
      `package.json declares ${declared}, but the repository lockfile belongs to ${lockManager}.`,
    );
  }
  const packageManager = (lockManager ?? declared) as
    PackageManager | undefined;
  if (!packageManager)
    throw new Error(
      "Could not detect a package manager from package.json or a lockfile.",
    );
  if (!parsed.dependencies?.next && !parsed.devDependencies?.next) {
    throw new Error(
      "The existing repository is not a Next.js project; automatic integration was not applied.",
    );
  }
  return packageManager;
}

export async function validateExistingProject(
  repositoryUrl: string,
  branch: string,
  projectName: string,
  token: string,
): Promise<ExistingProjectBuildInfo> {
  const tempDirectory = await mkdtemp(
    join(tmpdir(), "account-factory-existing-"),
  );
  const checkoutDirectory = join(tempDirectory, "repo");
  const askpassPath = join(tempDirectory, "git-askpass.sh");
  await writeFile(
    askpassPath,
    [
      "#!/bin/sh",
      'case "$1" in',
      "  *Username*) printf '%s\\n' 'x-access-token' ;;",
      "  *) printf '%s\\n' \"$ACCOUNT_FACTORY_GIT_TOKEN\" ;;",
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(askpassPath, 0o700);

  try {
    await run(
      "git",
      [
        "clone",
        "--depth=1",
        "--branch",
        branch,
        repositoryUrl,
        checkoutDirectory,
      ],
      tempDirectory,
      {
        ...sanitizedEnvironment(),
        ACCOUNT_FACTORY_GIT_TOKEN: token,
        GIT_ASKPASS: askpassPath,
        GIT_TERMINAL_PROMPT: "0",
      },
    );

    const packageJsonText = await readFile(
      join(checkoutDirectory, "package.json"),
      "utf8",
    ).catch(() => {
      throw new Error(
        "The existing repository has no package.json; automatic Next.js integration was not applied.",
      );
    });
    const packageJson = JSON.parse(packageJsonText) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};
    if (!scripts.build)
      throw new Error(
        "The existing repository has no build script; no files were pushed.",
      );

    const paths = new Set<string>();
    const collectPaths = async (directory: string, prefix = "") => {
      const { readdir, stat } = await import("node:fs/promises");
      for (const name of await readdir(directory)) {
        if (name === ".git" || name === "node_modules") continue;
        const relative = prefix ? `${prefix}/${name}` : name;
        paths.add(relative);
        if ((await stat(join(directory, name))).isDirectory())
          await collectPaths(join(directory, name), relative);
      }
    };
    await collectPaths(checkoutDirectory);
    const packageManager = detectPackageManager(packageJsonText, paths);
    const existingConfig = paths.has("nextjs-app.yml")
      ? (parse(
          await readFile(join(checkoutDirectory, "nextjs-app.yml"), "utf8"),
        ) as { app?: { commands?: Record<string, string> } })
      : undefined;
    const deploymentCommands = findDeploymentCommands(
      packageManager,
      scripts,
      paths,
      existingConfig?.app?.commands ?? {},
    );

    const hasLockfile =
      paths.has("yarn.lock") ||
      paths.has("package-lock.json") ||
      paths.has("pnpm-lock.yaml");
    await installDependencies(packageManager, hasLockfile, checkoutDirectory);
    for (const script of ["lint", "test", "typecheck", "build"]) {
      if (scripts[script])
        await runScript(packageManager, script, checkoutDirectory);
    }

    return {
      packageManager,
      installCommand: installCommand(packageManager, hasLockfile),
      scripts,
      ...deploymentCommands,
      yarnLock: "",
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function findDeploymentCommands(
  packageManager: PackageManager,
  scripts: Record<string, string>,
  paths: ReadonlySet<string>,
  existingCommands: Record<string, string>,
): Pick<
  ExistingProjectBuildInfo,
  "previewDeployCommand" | "productionDeployCommand" | "previewRemoveCommand"
> {
  const run = packageManager === "npm" ? "npm run" : `${packageManager} run`;
  if (
    existingCommands["preview-deploy"] &&
    existingCommands["production-deploy"]
  ) {
    return {
      previewDeployCommand: existingCommands["preview-deploy"],
      productionDeployCommand: existingCommands["production-deploy"],
      previewRemoveCommand: existingCommands["preview-remove"] ?? "",
    };
  }
  if (scripts["deploy:preview"] && scripts["deploy:production"]) {
    return {
      previewDeployCommand: `${run} deploy:preview`,
      productionDeployCommand: `${run} deploy:production`,
      previewRemoveCommand: scripts["remove:preview"]
        ? `${run} remove:preview`
        : "",
    };
  }
  if (
    paths.has("sst.config.ts") ||
    paths.has("sst.config.mjs") ||
    paths.has("sst.config.js")
  ) {
    return {
      previewDeployCommand: `${packageManager} sst deploy --stage preview-$PR_NUMBER`,
      productionDeployCommand: `${packageManager} sst deploy --stage production`,
      previewRemoveCommand: `${packageManager} sst remove --stage preview-$PR_NUMBER`,
    };
  }
  throw new Error(
    "The existing project has no deploy:preview/deploy:production scripts or SST config; no AWS account was created.",
  );
}

async function installDependencies(
  manager: PackageManager,
  hasLockfile: boolean,
  cwd: string,
): Promise<void> {
  if (manager === "npm") {
    await run(
      "npm",
      [hasLockfile ? "ci" : "install"],
      cwd,
      sanitizedEnvironment(),
    );
    return;
  }
  if (manager === "yarn") {
    await run(
      "corepack",
      ["yarn", "install", ...(hasLockfile ? ["--frozen-lockfile"] : [])],
      cwd,
      sanitizedEnvironment(),
    );
    return;
  }
  await run(
    "corepack",
    ["pnpm", "install", ...(hasLockfile ? ["--frozen-lockfile"] : [])],
    cwd,
    sanitizedEnvironment(),
  );
}

function installCommand(manager: PackageManager, hasLockfile: boolean): string {
  if (manager === "npm") return hasLockfile ? "npm ci" : "npm install";
  if (manager === "yarn")
    return `corepack enable && yarn install${hasLockfile ? " --frozen-lockfile" : ""}`;
  return `corepack enable && pnpm install${hasLockfile ? " --frozen-lockfile" : ""}`;
}

async function runScript(
  manager: PackageManager,
  script: string,
  cwd: string,
): Promise<void> {
  const command = manager === "npm" ? "npm" : "corepack";
  const args = manager === "npm" ? ["run", script] : [manager, "run", script];
  await run(command, args, cwd, sanitizedEnvironment());
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      /^(AWS_|GITHUB_|GH_|ACTIONS_|ACCOUNT_FACTORY_)/i.test(key) ||
      /(TOKEN|PASSWORD|SECRET|CREDENTIAL)/i.test(key)
    ) {
      delete environment[key];
    }
  }
  environment.CI = "true";
  return environment;
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await execFileAsync(command, args, {
      cwd,
      env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    });
  } catch (error) {
    const failure = error as {
      stderr?: string;
      stdout?: string;
      message?: string;
    };
    const detail = [failure.stdout, failure.stderr, failure.message]
      .filter(Boolean)
      .join("\n")
      .trim()
      .slice(-4000);
    throw new Error(
      `Command ${command} ${args.join(" ")} failed in ${cwd}: ${detail}`,
    );
  }
}
