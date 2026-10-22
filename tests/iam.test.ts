import { describe, expect, it } from "vitest";
import {
  deploymentPolicy,
  roleNames,
  roleTrustPolicy,
  runtimeBoundaryPolicy,
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

  it("requires a permissions boundary when creating project roles", () => {
    const policy = deploymentPolicy("123456789012", "storefront", "ssr") as {
      Statement: Array<{
        Action: string[];
        Resource?: string;
        Condition?: {
          ArnEquals?: Record<string, string>;
          StringEquals?: Record<string, string>;
        };
      }>;
    };
    const createRole = policy.Statement.find((statement) =>
      statement.Action.includes("iam:CreateRole"),
    );
    expect(createRole?.Condition?.ArnEquals?.["iam:PermissionsBoundary"]).toBe(
      "arn:aws:iam::123456789012:policy/storefront-runtime-boundary",
    );
    expect(
      policy.Statement.some((statement) =>
        statement.Action.includes("lambda:CreateFunction"),
      ),
    ).toBe(true);
    const passRole = policy.Statement.find((statement) =>
      statement.Action.includes("iam:PassRole"),
    );
    expect(passRole?.Resource).toBe(
      "arn:aws:iam::123456789012:role/storefront-*",
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

  it("adds ACM and Route 53 access only when a custom domain is configured", () => {
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
        statement.Action.includes("route53:ChangeResourceRecordSets"),
      ),
    ).toBe(true);
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

  it("limits runtime roles to app logs and app-owned buckets", () => {
    const policy = runtimeBoundaryPolicy("123456789012", "storefront") as {
      Statement: Array<{ Action: string[]; Resource: string }>;
    };
    expect(
      policy.Statement.every((statement) => statement.Resource !== "*"),
    ).toBe(true);
    expect(
      policy.Statement.some((statement) =>
        statement.Resource.includes("storefront-*"),
      ),
    ).toBe(true);
    expect(
      policy.Statement.some((statement) =>
        statement.Action.includes("iam:CreateRole"),
      ),
    ).toBe(false);
    expect(
      policy.Statement.some((statement) =>
        statement.Action.some(
          (action) =>
            action.startsWith("sqs:") || action.startsWith("dynamodb:"),
        ),
      ),
    ).toBe(false);
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
