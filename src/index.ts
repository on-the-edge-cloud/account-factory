import { appendFileSync } from "node:fs";
import pino from "pino";
import { createProject } from "./services/create-project.js";
import { validateProjectInput, type AppType } from "./validation.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

async function main() {
  const input = validateProjectInput({
    projectName: process.env.PROJECT_NAME ?? "",
    appType: (process.env.APP_TYPE ?? "") as AppType,
    awsRegion: process.env.AWS_REGION ?? "eu-west-1",
    nodeVersion: process.env.NODE_VERSION ?? "22",
    customDomain: process.env.CUSTOM_DOMAIN || undefined,
  });
  const githubToken = process.env.ACCOUNT_FACTORY_GITHUB_TOKEN;
  if (!githubToken)
    throw new Error("ACCOUNT_FACTORY_GITHUB_TOKEN is required.");

  const result = await createProject(input, githubToken);
  for (const [key, value] of Object.entries(result)) {
    const outputName = key.replace(
      /[A-Z]/g,
      (letter) => `_${letter.toLowerCase()}`,
    );
    const outputValue = Array.isArray(value)
      ? JSON.stringify(value)
      : String(value);
    logger.info({ output: outputName, value }, "Project provisioning output");
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `${outputName}=${outputValue}\n`,
      );
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "## Project provisioning outputs",
        "",
        "| Output | Value |",
        "| --- | --- |",
        `| AWS account ID | ${result.accountId} |`,
        `| Root email | ${result.rootEmail} |`,
        `| Preview role ARN | ${result.previewRoleArn} |`,
        `| Production role ARN | ${result.productionRoleArn} |`,
        `| Repository | ${result.repositoryUrl} |`,
        `| Files created | ${result.filesCreated.join(", ") || "None"} |`,
        `| Files updated | ${result.filesUpdated.join(", ") || "None"} |`,
        `| Files ignored | ${result.filesIgnored.join(", ") || "None"} |`,
        `| Status | ${result.status} |`,
        "",
      ].join("\n"),
    );
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "Project provisioning failed");
  process.exitCode = 1;
});
