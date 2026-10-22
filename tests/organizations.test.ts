import { describe, expect, it, vi } from "vitest";
import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { createAccount } from "../src/clients/organizations.js";

describe("AWS account creation", () => {
  it("sends the requested account details and returns the created account ID", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ CreateAccountStatus: { Id: "request-123" } })
      .mockResolvedValueOnce({ CreateAccountStatus: { State: "SUCCEEDED", AccountId: "123456789012" } });
    const client = { send } as unknown as OrganizationsClient;
    const createdAt = new Date("2026-10-22T10:00:00.000Z");

    const result = await createAccount(client, "mi-proyecto", "fmoreno+mi-proyecto@ontheedge.cloud", createdAt);
    const request = send.mock.calls[0][0].input;
    expect(request).toMatchObject({
      AccountName: "mi-proyecto",
      Email: "fmoreno+mi-proyecto@ontheedge.cloud",
      RoleName: "OrganizationAccountAccessRole",
      Tags: [
        { Key: "Project", Value: "mi-proyecto" },
        { Key: "ManagedBy", Value: "account-factory" },
        { Key: "RootEmail", Value: "fmoreno+mi-proyecto@ontheedge.cloud" },
        { Key: "CreatedAt", Value: "2026-10-22T10:00:00.000Z" },
      ],
    });
    expect(result).toEqual({ accountId: "123456789012", requestId: "request-123" });
  });
});