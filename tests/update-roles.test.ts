import {
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const aws = vi.hoisted(() => ({
  iamSend: vi.fn(),
  stsSend: vi.fn(),
}));
vi.mock("@aws-sdk/client-iam", async (importOriginal) => {
  const original = await importOriginal<typeof import("@aws-sdk/client-iam")>();
  return {
    ...original,
    IAMClient: class {
      send = aws.iamSend;
    },
  };
});
vi.mock("@aws-sdk/client-sts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@aws-sdk/client-sts")>();
  return {
    ...original,
    STSClient: class {
      send = aws.stsSend;
    },
  };
});

import { deploymentPolicy, updateProjectRoles } from "../src/clients/iam.js";

describe("updateProjectRoles", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    aws.stsSend.mockResolvedValue({
      Credentials: {
        AccessKeyId: "access",
        SecretAccessKey: "secret",
        SessionToken: "session",
      },
    });
    aws.iamSend.mockImplementation(async (command) => {
      if (command instanceof GetRoleCommand) {
        return {
          Role: {
            Arn: `arn:aws:iam::123456789012:role/${command.input.RoleName}`,
            Tags: [
              { Key: "Project", Value: "storefront" },
              { Key: "ManagedBy", Value: "account-factory" },
            ],
          },
        };
      }
      return {};
    });
  });

  it.each(["ssr", "static"] as const)(
    "replaces both existing policies with the shared %s policy without creating roles",
    async (appType) => {
      await updateProjectRoles(
        new STSClient({}),
        "123456789012",
        "storefront",
        appType,
        "app.example.com",
      );
      const assume = aws.stsSend.mock.calls[0][0];
      expect(assume).toBeInstanceOf(AssumeRoleCommand);
      expect(assume.input.RoleArn).toBe(
        "arn:aws:iam::123456789012:role/OrganizationAccountAccessRole",
      );
      const commands = aws.iamSend.mock.calls.map(([command]) => command);
      expect(commands).toHaveLength(4);
      expect(
        commands
          .slice(0, 2)
          .every((command) => command instanceof GetRoleCommand),
      ).toBe(true);
      expect(
        commands.some((command) => command instanceof CreateRoleCommand),
      ).toBe(false);
      for (const [index, suffix] of ["preview", "production"].entries()) {
        const command = commands[index + 2];
        expect(command).toBeInstanceOf(PutRolePolicyCommand);
        expect(command.input).toEqual({
          RoleName: `github-actions-storefront-${suffix}`,
          PolicyName: "storefront-deployment",
          PolicyDocument: JSON.stringify(
            deploymentPolicy(
              "123456789012",
              "storefront",
              appType,
              "app.example.com",
            ),
          ),
        });
      }
    },
  );

  it.each([
    { Arn: "arn:aws:iam::999999999999:role/other" },
    {
      Arn: "arn:aws:iam::123456789012:role/github-actions-storefront-production",
      Tags: [{ Key: "ManagedBy", Value: "other" }],
    },
    undefined,
  ])("validates both roles before any write: %j", async (role) => {
    aws.iamSend.mockResolvedValueOnce({
      Role: {
        Arn: "arn:aws:iam::123456789012:role/github-actions-storefront-preview",
        Tags: [
          { Key: "Project", Value: "storefront" },
          { Key: "ManagedBy", Value: "account-factory" },
        ],
      },
    });
    aws.iamSend.mockResolvedValueOnce({ Role: role });
    await expect(
      updateProjectRoles(
        new STSClient({}),
        "123456789012",
        "storefront",
        "ssr",
      ),
    ).rejects.toThrow(/no policies were updated/);
    expect(
      aws.iamSend.mock.calls.some(
        ([command]) => command instanceof PutRolePolicyCommand,
      ),
    ).toBe(false);
  });

  it("surfaces AWS write failures", async () => {
    aws.iamSend.mockImplementation(async (command) => {
      if (command instanceof PutRolePolicyCommand) {
        throw new Error("AccessDenied");
      }
      return {
        Role: {
          Arn: `arn:aws:iam::123456789012:role/${command.input.RoleName}`,
          Tags: [
            { Key: "Project", Value: "storefront" },
            { Key: "ManagedBy", Value: "account-factory" },
          ],
        },
      };
    });
    await expect(
      updateProjectRoles(
        new STSClient({}),
        "123456789012",
        "storefront",
        "ssr",
      ),
    ).rejects.toThrow("AccessDenied");
  });
});
