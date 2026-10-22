import {
  CreateAccountCommand,
  DescribeCreateAccountStatusCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";

export interface AccountResult {
  accountId: string;
  requestId: string;
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function organizationsError(error: unknown): Error {
  const code = (error as { name?: string })?.name ?? "";
  const message = (error as Error)?.message ?? "";
  if (/EMAIL_ALREADY_EXISTS|already exists/i.test(`${code} ${message}`)) {
    return new Error("Ya existe una cuenta AWS con ese email; elige otro nombre de proyecto.");
  }
  if (/INVALID_EMAIL|invalid.*email/i.test(`${code} ${message}`)) {
    return new Error("AWS rechazó el email root generado. Verifica fmoreno+<project_name>@ontheedge.cloud.");
  }
  if (/ACCOUNT_LIMIT_EXCEEDED|account limit/i.test(`${code} ${message}`)) {
    return new Error("Se alcanzó el límite de cuentas de la organización AWS.");
  }
  const messages: Record<string, string> = {
    EMAIL_ALREADY_EXISTS: "Ya existe una cuenta AWS con ese email; elige otro nombre de proyecto.",
    INVALID_EMAIL: "AWS rechazó el email root generado. Verifica fmoreno+<project_name>@ontheedge.cloud.",
    ACCOUNT_LIMIT_EXCEEDED: "Se alcanzó el límite de cuentas de la organización AWS.",
  };
  return new Error(messages[code] ?? `No se pudo crear la cuenta AWS: ${message || code}`);
}

export async function createAccount(
  client: OrganizationsClient,
  projectName: string,
  email: string,
  now = new Date(),
): Promise<AccountResult> {
  try {
    const created = await client.send(new CreateAccountCommand({
      AccountName: projectName,
      Email: email,
      RoleName: "OrganizationAccountAccessRole",
      Tags: [
        { Key: "Project", Value: projectName },
        { Key: "ManagedBy", Value: "account-factory" },
        { Key: "RootEmail", Value: email },
        { Key: "CreatedAt", Value: now.toISOString() },
      ],
    }));
    const requestId = created.CreateAccountStatus?.Id;
    if (!requestId) throw new Error("AWS did not return a CreateAccount request ID.");

    const deadline = Date.now() + 45 * 60 * 1000;
    while (Date.now() < deadline) {
      const status = await client.send(new DescribeCreateAccountStatusCommand({ CreateAccountRequestId: requestId }));
      const result = status.CreateAccountStatus;
      if (result?.State === "SUCCEEDED" && result.AccountId) {
        return { accountId: result.AccountId, requestId };
      }
      if (result?.State === "FAILED") {
        throw new Error(`AWS account creation failed (${result.FailureReason ?? "unknown reason"}).`);
      }
      await sleep(15_000);
    }
    throw new Error("Timed out waiting for AWS Organizations to create the account.");
  } catch (error) {
    if ((error as Error).message.startsWith("AWS account creation failed") || (error as Error).message.startsWith("Timed out")) {
      throw error;
    }
    throw organizationsError(error);
  }
}