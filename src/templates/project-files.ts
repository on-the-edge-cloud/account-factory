import { parseDocument, stringify } from "yaml";
import {
  accountEmail,
  type AppType,
  type ProjectInput,
} from "../validation.js";
import type { RoleNames } from "../clients/iam.js";

export type PackageManager = "yarn" | "npm" | "pnpm";

export interface ProjectFileOptions {
  existing?: boolean;
  existingPaths?: ReadonlySet<string>;
  existingManifest?: string;
  packageManager?: PackageManager;
  scripts?: Record<string, string>;
  previewDeployCommand?: string;
  productionDeployCommand?: string;
  branch?: string;
}

export interface ProjectFilePlan {
  files: Record<string, string>;
  created: string[];
  updated: string[];
  ignored: string[];
  workflowPaths: { preview: string; deploy: string };
}

export function projectManifest(
  input: ProjectInput,
  accountId: string,
  roles: RoleNames,
  options: ProjectFileOptions = {},
): string {
  const packageManager = options.packageManager ?? "yarn";
  const isNew = !options.existing;
  const scripts =
    options.scripts ??
    (isNew ? { build: "build", lint: "lint", typecheck: "typecheck" } : {});
  const run = packageManager === "npm" ? "npm run" : `${packageManager} run`;
  const install =
    packageManager === "npm"
      ? "npm ci"
      : packageManager === "yarn"
        ? "corepack enable && yarn install --frozen-lockfile"
        : "corepack enable && pnpm install --frozen-lockfile";
  const existingDocument = options.existingManifest
    ? parseDocument(options.existingManifest)
    : undefined;
  if (existingDocument?.errors.length) {
    throw new Error(
      `nextjs-app.yml is invalid: ${existingDocument.errors[0].message}`,
    );
  }
  const priorDomain = existingDocument?.getIn(["app", "domain"]);
  const deploymentCommands = {
    install,
    build: scripts.build ? `${run} build` : "",
    lint: scripts.lint ? `${run} lint` : "",
    typecheck: scripts.typecheck ? `${run} typecheck` : "",
    test: scripts.test ? `${run} test` : "",
    "preview-deploy":
      options.previewDeployCommand ??
      (isNew ? `${packageManager} sst deploy --stage preview-$PR_NUMBER` : ""),
    "production-deploy":
      options.productionDeployCommand ??
      (isNew ? `${packageManager} sst deploy --stage production` : ""),
    "preview-remove": isNew
      ? `${packageManager} sst remove --stage preview-$PR_NUMBER`
      : "",
  };
  const app: Record<string, unknown> = {
    name: input.projectName,
    framework: "nextjs",
    language: "typescript",
    "package-manager": packageManager,
    "node-version": input.nodeVersion,
    "aws-region": input.awsRegion,
    "aws-account-id": accountId,
    "root-email": accountEmail(input.projectName),
    "preview-role-arn": `arn:aws:iam::${accountId}:role/${roles.preview}`,
    "production-role-arn": `arn:aws:iam::${accountId}:role/${roles.production}`,
    "deployment-type": input.appType,
    "deployment-strategy":
      input.appType === "static"
        ? "s3-cloudfront"
        : "cloudfront-api-gateway-lambda",
    domain:
      input.customDomain ?? (options.existing ? (priorDomain ?? null) : null),
    "domain-provider": input.customDomain
      ? { certificate: "acm", dns: "route53" }
      : null,
    "output-directory": input.appType === "static" ? "out" : ".next",
    commands: deploymentCommands,
  };

  if (!existingDocument) return stringify({ app }, { lineWidth: 0 });

  const existingApp = existingDocument.get("app", true);
  if (
    !existingApp ||
    typeof existingApp !== "object" ||
    !("set" in existingApp)
  ) {
    existingDocument.set("app", {});
  }
  for (const [key, value] of Object.entries(app)) {
    if (
      key === "domain" &&
      input.customDomain === undefined &&
      priorDomain !== undefined
    )
      continue;
    if (key === "commands") {
      for (const [commandName, commandValue] of Object.entries(
        deploymentCommands,
      )) {
        if (commandValue !== "")
          existingDocument.setIn(
            ["app", "commands", commandName],
            commandValue,
          );
      }
    } else {
      existingDocument.setIn(["app", key], value);
    }
  }
  return existingDocument.toString();
}

export function planProjectFiles(
  input: ProjectInput,
  accountId: string,
  roles: RoleNames,
  options: ProjectFileOptions = {},
): ProjectFilePlan {
  const existingPaths = options.existingPaths ?? new Set<string>();
  const previewChoice = chooseWorkflowPath(
    ".github/workflows/preview.yml",
    ".github/workflows/aws-preview.yml",
    existingPaths,
  );
  const deployChoice = chooseWorkflowPath(
    ".github/workflows/deploy.yml",
    ".github/workflows/aws-deploy.yml",
    existingPaths,
  );
  const workflowPaths = {
    preview: previewChoice.path,
    deploy: deployChoice.path,
  };
  const files: Record<string, string> = {
    [workflowPaths.preview]: deploymentWorkflow(input, "preview", options),
    [workflowPaths.deploy]: deploymentWorkflow(input, "production", options),
    "nextjs-app.yml": projectManifest(input, accountId, roles, options),
  };
  if (!options.existing)
    Object.assign(files, newApplicationFiles(input, accountId));

  const created = Object.keys(files).filter((path) => !existingPaths.has(path));
  const updated =
    options.existing && options.existingManifest ? ["nextjs-app.yml"] : [];
  const ignored = [previewChoice.ignored, deployChoice.ignored].filter(
    (path): path is string => Boolean(path),
  );
  return { files, created, updated, ignored, workflowPaths };
}

export function projectFiles(
  input: ProjectInput,
  accountId: string,
  roles: RoleNames,
): Record<string, string> {
  return planProjectFiles(input, accountId, roles).files;
}

function chooseWorkflowPath(
  primary: string,
  alternate: string,
  existingPaths: ReadonlySet<string>,
) {
  if (!existingPaths.has(primary)) return { path: primary, ignored: undefined };
  if (existingPaths.has(alternate)) {
    throw new Error(
      `Both ${primary} and ${alternate} exist; refusing to overwrite either workflow.`,
    );
  }
  return { path: alternate, ignored: primary };
}

function newApplicationFiles(
  input: ProjectInput,
  accountId: string,
): Record<string, string> {
  const boundaryArn = `arn:aws:iam::${accountId}:policy/${input.projectName}-runtime-boundary`;
  const roleTransform = `transform: { role: { permissionsBoundary: ${JSON.stringify(boundaryArn)} } }`;
  const domain = input.customDomain ? ", domain: deploymentDomain" : "";
  const resource =
    input.appType === "static"
      ? `new sst.aws.StaticSite("Web", { path: ".", build: { command: "yarn build", output: "out" }${domain} })`
      : `new sst.aws.Nextjs("Web", { path: "."${domain}, transform: { server: { ${roleTransform} }, imageOptimizer: { ${roleTransform} }, revalidationSeeder: { ${roleTransform} }, revalidationEventsSubscriber: { ${roleTransform} } } })`;
  const nextConfig = [
    'import type { NextConfig } from "next";',
    "const nextConfig: NextConfig = {",
    ...(input.appType === "static" ? ['  output: "export",'] : []),
    "};",
    "export default nextConfig;",
    "",
  ].join("\n");
  return {
    ".gitignore":
      "node_modules/\n.next/\nout/\n.env*\n!.env.example\n.turbo/\n",
    ".eslintrc.json":
      JSON.stringify(
        { extends: ["next/core-web-vitals", "next/typescript"] },
        null,
        2,
      ) + "\n",
    ".prettierrc.json":
      JSON.stringify({ semi: true, trailingComma: "all" }, null, 2) + "\n",
    "package.json":
      JSON.stringify(
        {
          name: input.projectName,
          version: "1.0.0",
          private: true,
          packageManager: "yarn@1.22.22",
          scripts: {
            dev: "next dev",
            build: "next build",
            lint: "next lint",
            typecheck: "tsc --noEmit",
            format: "prettier --write .",
          },
          dependencies: {
            next: "^15.0.0",
            react: "^19.0.0",
            "react-dom": "^19.0.0",
            sst: "^3.17.0",
          },
          devDependencies: {
            "@types/node": "^22.0.0",
            "@types/react": "^19.0.0",
            eslint: "^8.57.0",
            "eslint-config-next": "^15.0.0",
            prettier: "^3.6.0",
            typescript: "^5.9.0",
          },
        },
        null,
        2,
      ) + "\n",
    "tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2017",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            plugins: [{ name: "next" }],
            paths: { "@/*": ["./src/*"] },
          },
          include: [
            "next-env.d.ts",
            "**/*.ts",
            "**/*.tsx",
            ".next/types/**/*.ts",
          ],
          exclude: ["node_modules", "sst.config.ts"],
        },
        null,
        2,
      ) + "\n",
    "next.config.ts": nextConfig,
    "src/app/globals.css":
      "* { box-sizing: border-box; }\nbody { margin: 0; font-family: Arial, sans-serif; }\nmain { min-height: 100vh; display: grid; place-items: center; }\n",
    "src/app/layout.tsx": `import type { Metadata } from "next";\nimport "./globals.css";\n\nexport const metadata: Metadata = { title: ${JSON.stringify(input.projectName)}, description: "Project application" };\n\nexport default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n`,
    "src/app/page.tsx": `export default function Home() {\n  return <main><h1>${input.projectName} is ready</h1></main>;\n}\n`,
    "README.md": `# ${input.projectName}\n\nNext.js ${input.appType} project. This repository owns and deploys its AWS application resources.\n`,
    "sst.config.ts": [
      "export default $config({",
      "  app(input) {",
      `    return { name: ${JSON.stringify(input.projectName)}, home: "aws", removal: input?.stage === "production" ? "retain" : "remove" };`,
      "  },",
      "  async run() {",
      `    const deploymentDomain = process.env.STAGE === "production" ? ${JSON.stringify(input.customDomain ?? "")} : undefined;`,
      `    return ${resource};`,
      "  },",
      "});",
      "",
    ].join("\n"),
  };
}

function deploymentWorkflow(
  input: ProjectInput,
  stage: "preview" | "production",
  options: ProjectFileOptions,
): string {
  const isPreview = stage === "preview";
  const branch = options.branch ?? "main";
  const trigger = isPreview
    ? `  pull_request:\n    branches: [${branch}]\n  workflow_dispatch: {}`
    : `  push:\n    branches: [${branch}]\n  workflow_dispatch: {}`;
  const roleKey = isPreview ? "preview-role-arn" : "production-role-arn";
  const deployKey = isPreview ? "preview-deploy" : "production-deploy";
  const runCommand = 'bash -euo pipefail -c "$APP_COMMAND"';
  const steps = [
    "      - uses: actions/checkout@v4",
    "      - id: app-config",
    "        shell: bash",
    "        run: |",
    "          ruby -ryaml -e '",
    '            app = YAML.safe_load_file("nextjs-app.yml").fetch("app")',
    '            commands = app.fetch("commands", {})',
    `            values = { "aws_region" => app.fetch("aws-region"), "node_version" => app.fetch("node-version"), "package_manager" => app.fetch("package-manager"), "deployment_strategy" => app.fetch("deployment-strategy"), "output_directory" => app.fetch("output-directory"), "domain" => app["domain"], "install_command" => commands["install"], "build_command" => commands["build"], "lint_command" => commands["lint"], "test_command" => commands["test"], "typecheck_command" => commands["typecheck"], "deploy_command" => commands["${deployKey}"], "remove_command" => commands["preview-remove"], "role_arn" => app.fetch("${roleKey}") }`,
    '            values.each { |key, value| text = value.to_s; abort("Invalid multiline config value: #{key}") if text.include?("\\n"); puts "#{key}=#{text}" }',
    '          \' >> "$GITHUB_OUTPUT"',
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: ${{ steps.app-config.outputs.node_version }}",
    "      - name: Install dependencies",
    `        run: ${runCommand}`,
    "        env:",
    "          APP_COMMAND: ${{ steps.app-config.outputs.install_command }}",
    ...[
      "      - name: Lint",
      "        if: steps.app-config.outputs.lint_command != ''",
      `        run: ${runCommand}`,
      "        env:",
      "          APP_COMMAND: ${{ steps.app-config.outputs.lint_command }}",
      "      - name: Test",
      "        if: steps.app-config.outputs.test_command != ''",
      `        run: ${runCommand}`,
      "        env:",
      "          APP_COMMAND: ${{ steps.app-config.outputs.test_command }}",
      "      - name: Typecheck",
      "        if: steps.app-config.outputs.typecheck_command != ''",
      `        run: ${runCommand}`,
      "        env:",
      "          APP_COMMAND: ${{ steps.app-config.outputs.typecheck_command }}",
    ],
    "      - name: Build",
    `        run: ${runCommand}`,
    "        env:",
    "          APP_COMMAND: ${{ steps.app-config.outputs.build_command }}",
  ];
  if (isPreview) {
    steps.push(
      "      - name: Configure AWS credentials",
      "        if: github.event_name == 'pull_request'",
      "        uses: aws-actions/configure-aws-credentials@v4",
      "        with:",
      "          role-to-assume: ${{ steps.app-config.outputs.role_arn }}",
      "          aws-region: ${{ steps.app-config.outputs.aws_region }}",
      "      - name: Deploy preview",
      "        if: github.event_name == 'pull_request' && github.event.action != 'closed'",
      `        run: ${runCommand}`,
      "        env:",
      "          APP_COMMAND: ${{ steps.app-config.outputs.deploy_command }}",
      "          PR_NUMBER: ${{ github.event.pull_request.number }}",
      "          DEPLOYMENT_STRATEGY: ${{ steps.app-config.outputs.deployment_strategy }}",
      "          OUTPUT_DIRECTORY: ${{ steps.app-config.outputs.output_directory }}",
      "          APP_DOMAIN: ${{ steps.app-config.outputs.domain }}",
      "      - name: Remove preview",
      "        if: github.event_name == 'pull_request' && github.event.action == 'closed'",
      `        run: ${runCommand}`,
      "        env:",
      "          APP_COMMAND: ${{ steps.app-config.outputs.remove_command }}",
      "          PR_NUMBER: ${{ github.event.pull_request.number }}",
    );
  } else {
    steps.push(
      "      - name: Configure AWS credentials",
      "        uses: aws-actions/configure-aws-credentials@v4",
      "        with:",
      "          role-to-assume: ${{ steps.app-config.outputs.role_arn }}",
      "          aws-region: ${{ steps.app-config.outputs.aws_region }}",
      "      - name: Deploy production",
      `        run: ${runCommand}`,
      "        env:",
      "          APP_COMMAND: ${{ steps.app-config.outputs.deploy_command }}",
      "          DEPLOYMENT_STRATEGY: ${{ steps.app-config.outputs.deployment_strategy }}",
      "          OUTPUT_DIRECTORY: ${{ steps.app-config.outputs.output_directory }}",
      "          APP_DOMAIN: ${{ steps.app-config.outputs.domain }}",
    );
  }
  return [
    `name: ${isPreview ? "Preview" : "Deploy"}`,
    "on:",
    trigger,
    "permissions:",
    "  id-token: write",
    "  contents: read",
    "jobs:",
    "  deploy:",
    `    if: github.ref == 'refs/heads/${branch}' || github.event_name == 'pull_request'`,
    "    runs-on: ubuntu-latest",
    ...(isPreview ? [] : ["    environment: production"]),
    "    steps:",
    ...steps,
    "",
  ].join("\n");
}

export function canDeployApplication(appType: AppType): boolean {
  return appType === "static" || appType === "ssr";
}
