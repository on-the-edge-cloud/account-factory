import { describe, expect, it } from "vitest";
import {
  deploymentPolicy,
  roleNames,
  roleTrustPolicy,
} from "../src/clients/iam.js";
import { organizationsError } from "../src/clients/organizations.js";

describe("IAM role configuration", () => {
  it("uses the required role names and enforces AWS's name limit", () => {
    expect(roleNames("my-app")).toEqual({
      preview: "github-actions-my-app-preview",
      production: "github-actions-my-app-production",
    });
    expect(() => roleNames("a".repeat(39))).toThrow(/maximum 38/);
  });

  it("grants Terraform state access only to this repository's state prefix", () => {
    const policy = deploymentPolicy("123456789012", "storefront", "ssr") as {
      Statement: Array<{
        Action: string[];
        Resource: string | string[];
        Condition?: { StringLike?: Record<string, string[]> };
      }>;
    };
    const stateList = policy.Statement.find((statement) =>
      statement.Action.includes("s3:ListBucket"),
    );
    const stateObjects = policy.Statement.find((statement) =>
      statement.Action.includes("s3:GetObject"),
    );

    expect(stateList?.Resource).toBe(
      "arn:aws:s3:::on-the-edge-terraform-state",
    );
    expect(stateList?.Condition?.StringLike?.["s3:prefix"]).toEqual([
      "nextjs/on-the-edge-cloud/storefront/*",
    ]);
    expect(stateObjects?.Resource).toBe(
      "arn:aws:s3:::on-the-edge-terraform-state/nextjs/on-the-edge-cloud/storefront/*",
    );
  });

  it("grants SSR Terraform permissions to resources named with the manifest slug", () => {
    const policy = deploymentPolicy("123456789012", "storefront", "ssr") as {
      Statement: Array<{
        Action: string[];
        Resource?: string;
        Condition?: { StringEquals?: Record<string, string> };
      }>;
    };
    const createRole = policy.Statement.find((statement) =>
      statement.Action.includes("iam:CreateRole"),
    );
    expect(createRole?.Resource).toBe(
      "arn:aws:iam::123456789012:role/storefront*",
    );
    expect(createRole?.Condition).toBeUndefined();
    expect(
      policy.Statement.some((statement) =>
        statement.Action.includes("lambda:CreateFunction"),
      ),
    ).toBe(true);
    const passRole = policy.Statement.find((statement) =>
      statement.Action.includes("iam:PassRole"),
    );
    expect(passRole?.Resource).toBe(
      "arn:aws:iam::123456789012:role/storefront*",
    );
    expect(passRole?.Condition?.StringEquals?.["iam:PassedToService"]).toBe(
      "lambda.amazonaws.com",
    );
  });

  it("does not grant static projects IAM or Lambda deployment permissions", () => {
    const policy = deploymentPolicy("123456789012", "storefront", "static") as {
      Statement: Array<{ Action: string[] }>;
    };
    expect(
      policy.Statement.some((statement) =>
        statement.Action.some((action) => action.startsWith("lambda:")),
      ),
    ).toBe(false);
    expect(
      policy.Statement.some((statement) =>
        statement.Action.includes("iam:CreateRole"),
      ),
    ).toBe(false);
  });

  it("adds ACM access only when a custom domain is configured", () => {
    const withoutDomain = deploymentPolicy(
      "123456789012",
      "storefront",
      "static",
    ) as { Statement: Array<{ Action: string[] }> };
    const withDomain = deploymentPolicy(
      "123456789012",
      "storefront",
      "static",
      "app.example.com",
    ) as { Statement: Array<{ Action: string[] }> };
    expect(
      withoutDomain.Statement.some((statement) =>
        statement.Action.some(
          (action) =>
            action.startsWith("acm:") || action.startsWith("route53:"),
        ),
      ),
    ).toBe(false);
    expect(
      withDomain.Statement.some((statement) =>
        statement.Action.includes("acm:RequestCertificate"),
      ),
    ).toBe(true);
    expect(
      withDomain.Statement.some((statement) =>
        statement.Action.some((action) => action.startsWith("route53:")),
      ),
    ).toBe(false);
  });

  it("uses the exact organization-wide OIDC subjects for both roles", () => {
    const preview = roleTrustPolicy(
      "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com",
      false,
    ) as {
      Statement: Array<{
        Condition: {
          StringEquals: Record<string, string>;
          StringLike: Record<string, string>;
        };
      }>;
    };
    const production = roleTrustPolicy(
      "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com",
      true,
    ) as typeof preview;
    expect(
      preview.Statement[0].Condition.StringLike[
        "token.actions.githubusercontent.com:sub"
      ],
    ).toBe("repo:on-the-edge-cloud*:pull_request");
    expect(
      production.Statement[0].Condition.StringLike[
        "token.actions.githubusercontent.com:sub"
      ],
    ).toBe("repo:on-the-edge-cloud*:environment:production");
    expect(
      preview.Statement[0].Condition.StringEquals[
        "token.actions.githubusercontent.com:aud"
      ],
    ).toBe("sts.amazonaws.com");
  });

  it("uses Terraform provider permissions instead of legacy deployment APIs", () => {
    const policy = deploymentPolicy(
      "123456789012",
      "storefront",
      "ssr",
      "app.example.com",
    ) as { Statement: Array<{ Action: string[] }> };
    const actions = policy.Statement.flatMap((statement) => statement.Action);

    expect(actions.some((action) => action.startsWith("cloudformation:"))).toBe(
      false,
    );
    expect(actions.some((action) => action.startsWith("route53:"))).toBe(false);
    expect(actions).toContain("dynamodb:CreateTable");
    expect(actions).toContain("sqs:CreateQueue");
    expect(actions).toContain("cloudfront:CreateDistribution");
    expect(actions).toContain("acm:RequestCertificate");
  });
});

describe("AWS Organizations error messages", () => {
  it("maps AWS service exception names to actionable errors", () => {
    expect(
      organizationsError({
        name: "DuplicateAccountException",
        message: "Email already exists",
      }).message,
    ).toMatch(/otro nombre/);
    expect(
      organizationsError({
        name: "InvalidInputException",
        message: "INVALID_EMAIL",
      }).message,
    ).toMatch(/email root/);
    expect(
      organizationsError({
        name: "ConstraintViolationException",
        message: "ACCOUNT_LIMIT_EXCEEDED",
      }).message,
    ).toMatch(/límite/);
  });
});
