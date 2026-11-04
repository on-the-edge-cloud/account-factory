import { appendFileSync } from "node:fs";
import pino from "pino";
import { z } from "zod";
import {
  updateProject,
  updateProjectWarning,
} from "../services/update-project.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

async function main() {
  const githubToken = process.env.ACCOUNT_FACTORY_GITHUB_TOKEN;
  if (!githubToken)
    throw new Error("ACCOUNT_FACTORY_GITHUB_TOKEN is required.");
  logger.warn(updateProjectWarning);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Update project\n\n**Warning:** ${updateProjectWarning}\n\nIAM updates and the GitHub commit are not transactional. On failure, inspect both roles and the manifest before retrying. No rollback is performed.\n\n`,
    );
  }
  const result = await updateProject(
    {
      projectName: process.env.PROJECT_NAME ?? "",
      accountId: process.env.ACCOUNT_ID ?? "",
      appType: z.enum(["static", "ssr"]).parse(process.env.APP_TYPE),
    },
    githubToken,
  );
  logger.info(result, "Project updated");
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Account: ${result.accountId}\n\nType: ${result.previousType} -> ${result.appType}\n\nManifest updated: ${result.manifestUpdated}\n\nRepository: ${result.repositoryUrl}\n\nIf no commit was needed, rerun the project's deployment workflow manually.\n`,
    );
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "Project update failed");
  process.exitCode = 1;
});
