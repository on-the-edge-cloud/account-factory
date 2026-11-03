import { isUtf8 } from "node:buffer";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectInput } from "../validation.js";

type PackageManager = "yarn" | "npm" | "pnpm";

const execFileAsync = promisify(execFile);

export interface ExistingProjectBuildInfo {
  yarnLock: string;
  applicationFiles?: Record<string, string>;
}

export async function validateNewProject(
  input: ProjectInput,
): Promise<ExistingProjectBuildInfo> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "account-factory-new-"));
  try {
    const projectDirectory = join(tempDirectory, input.projectName);
    const scaffold = [
      "--yes",
      "create-next-app@canary",
      input.projectName,
      "--yes",
      "--use-yarn",
      "--skip-install",
      ...(input.appType === "static"
        ? ["--example", "with-static-export"]
        : ["--ts", "--eslint", "--tailwind", "--app", "--no-agents-md"]),
    ];
    await run("npx", scaffold, tempDirectory);

    const packageJsonPath = join(projectDirectory, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    packageJson.dependencies.next = "latest";
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );

    await installDependencies("yarn", false, projectDirectory);
    await runScript("yarn", "build", projectDirectory);
    const applicationFiles = await collectApplicationFiles(projectDirectory);
    return {
      yarnLock: await readFile(join(projectDirectory, "yarn.lock"), "utf8"),
      applicationFiles,
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function collectApplicationFiles(
  root: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const collect = async (directory: string, prefix = "") => {
    for (const entry of await readdir(directory)) {
      if ([".git", ".next", "node_modules", "out", "coverage"].includes(entry))
        continue;
      const path = prefix ? `${prefix}/${entry}` : entry;
      const absolutePath = join(directory, entry);
      if ((await stat(absolutePath)).isDirectory()) {
        await collect(absolutePath, path);
        continue;
      }
      if (entry === "favicon.ico" || entry.endsWith(".tsbuildinfo")) continue;
      const content = await readFile(absolutePath);
      if (!isUtf8(content))
        throw new Error(`Generated template file is not UTF-8 text: ${path}`);
      if (path !== "yarn.lock") files[path] = content.toString("utf8");
    }
  };
  await collect(root);
  return files;
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
      yarnLock: "",
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function installDependencies(
  manager: PackageManager,
  hasLockfile: boolean,
  cwd: string,
): Promise<void> {
  const args =
    manager === "npm"
      ? [hasLockfile ? "ci" : "install"]
      : ["install", ...(hasLockfile ? ["--frozen-lockfile"] : [])];
  await runPackageManager(manager, args, cwd);
}

async function runScript(
  manager: PackageManager,
  script: string,
  cwd: string,
): Promise<void> {
  await runPackageManager(manager, ["run", script], cwd);
}

async function runPackageManager(
  manager: PackageManager,
  args: string[],
  cwd: string,
): Promise<void> {
  const command = manager === "npm" ? "npm" : "corepack";
  await run(command, manager === "npm" ? args : [manager, ...args], cwd);
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
  env = sanitizedEnvironment(),
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
