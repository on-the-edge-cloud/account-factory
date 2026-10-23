import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

export interface TemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export async function assumeOrganizationAccessRole(
  managementClient: STSClient,
  accountId: string,
): Promise<TemporaryCredentials> {
  const response = await managementClient.send(
    new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${accountId}:role/OrganizationAccountAccessRole`,
      RoleSessionName: "account-factory-setup",
    }),
  );
  const credentials = response.Credentials;
  if (
    !credentials?.AccessKeyId ||
    !credentials.SecretAccessKey ||
    !credentials.SessionToken
  ) {
    throw new Error(
      `Could not assume OrganizationAccountAccessRole in ${accountId}.`,
    );
  }
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
  };
}
