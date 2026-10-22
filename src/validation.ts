import { z } from "zod";

export type AppType = "static" | "ssr";

export interface ProjectInput {
  projectName: string;
  appType: AppType;
  awsRegion: string;
  nodeVersion: string;
  customDomain?: string;
}

const projectInputSchema = z.object({
  projectName: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(40),
  appType: z.enum(["static", "ssr"]),
  awsRegion: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-[0-9]$/).default("eu-west-1"),
  nodeVersion: z.string().regex(/^\d+$/).default("22"),
  customDomain: z.string().refine(isValidDomain, "Must be a DNS hostname").optional(),
});

export function validateProjectInput(input: ProjectInput): ProjectInput {
  const result = projectInputSchema.safeParse(input);
  if (!result.success) {
    throw new Error(result.error.issues.map((issue) => {
      const path = issue.path.join(".").replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      return `${path}: ${issue.message}`;
    }).join("; "));
  }
  return result.data;
}

export function isValidDomain(domain: string): boolean {
  if (domain.length > 253 || domain.endsWith(".")) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && /[a-z]/i.test(labels[labels.length - 1]) && labels.every((label) =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

export function accountEmail(projectName: string): string {
  return `fmoreno+${projectName}@ontheedge.cloud`;
}