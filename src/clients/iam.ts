import {
  CreateOpenIDConnectProviderCommand,
  CreatePolicyCommand,
  CreateRoleCommand,
  GetOpenIDConnectProviderCommand,
  IAMClient,
  ListOpenIDConnectProvidersCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { STSClient } from "@aws-sdk/client-sts";
import { assumeOrganizationAccessRole } from "./sts.js";
import type { AppType } from "../validation.js";

export interface RoleNames {
  preview: string;
  production: string;
}

export function roleNames(projectName: string): RoleNames {
  const roles = {
    preview: `github-actions-${projectName}-preview`,
    production: `github-actions-${projectName}-production`,
  };
  if (roles.preview.length > 64 || roles.production.length > 64) {
    throw new Error(
      "project_name is too long for the required AWS IAM role names (maximum 38 characters).",
    );
  }
  return roles;
}

export function deploymentPolicy(
  accountId: string,
  projectName: string,
  appType: AppType,
  customDomain?: string,
): object {
  const common: Array<Record<string, unknown>> = [
    {
      Effect: "Allow",
      Action: [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:CreateChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:ListStackResources",
        "cloudformation:GetTemplate",
      ],
      Resource: [
        `arn:aws:cloudformation:*:${accountId}:stack/${projectName}-*/*`,
        `arn:aws:cloudformation:*:${accountId}:changeSet/${projectName}-*/*`,
      ],
    },
    {
      Effect: "Allow",
      Action: ["cloudformation:ListStacks", "cloudformation:ValidateTemplate"],
      Resource: "*",
    },
    {
      Effect: "Allow",
      Action: [
        "s3:CreateBucket",
        "s3:GetBucket*",
        "s3:PutBucket*",
        "s3:ListBucket",
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
      ],
      Resource: [
        `arn:aws:s3:::sst-state-${accountId}-*`,
        `arn:aws:s3:::sst-state-${accountId}-*/*`,
      ],
    },
    {
      Effect: "Allow",
      Action: [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:GetBucket*",
        "s3:PutBucket*",
        "s3:ListBucket",
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:PutObject",
      ],
      Resource: [
        `arn:aws:s3:::${projectName}-*`,
        `arn:aws:s3:::${projectName}-*/*`,
      ],
    },
    {
      Effect: "Allow",
      Action: [
        "cloudfront:CreateDistribution",
        "cloudfront:UpdateDistribution",
        "cloudfront:DeleteDistribution",
        "cloudfront:GetDistribution",
        "cloudfront:GetDistributionConfig",
        "cloudfront:ListDistributions",
        "cloudfront:TagResource",
        "cloudfront:UntagResource",
      ],
      Resource: "*",
    },
    { Effect: "Allow", Action: ["sts:GetCallerIdentity"], Resource: "*" },
  ];
  if (appType === "ssr") {
    common.push(
      {
        Effect: "Allow",
        Action: ["iam:CreateRole"],
        Resource: `arn:aws:iam::${accountId}:role/${projectName}-*`,
        Condition: {
          ArnEquals: {
            "iam:PermissionsBoundary": `arn:aws:iam::${accountId}:policy/${projectName}-runtime-boundary`,
          },
        },
      },
      {
        Effect: "Allow",
        Action: [
          "iam:DeleteRole",
          "iam:GetRole",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:PutRolePolicy",
          "iam:GetRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
        ],
        Resource: `arn:aws:iam::${accountId}:role/${projectName}-*`,
      },
      {
        Effect: "Allow",
        Action: ["iam:PassRole"],
        Resource: `arn:aws:iam::${accountId}:role/${projectName}-*`,
        Condition: {
          StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" },
        },
      },
      {
        Effect: "Allow",
        Action: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
        ],
        Resource: `arn:aws:logs:*:${accountId}:log-group:/aws/*/${projectName}-*:*`,
      },
      {
        Effect: "Allow",
        Action: [
          "lambda:CreateFunction",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:DeleteFunction",
          "lambda:GetFunction",
          "lambda:TagResource",
          "lambda:UntagResource",
        ],
        Resource: `arn:aws:lambda:*:${accountId}:function:${projectName}-*`,
      },
      {
        Effect: "Allow",
        Action: [
          "apigateway:GET",
          "apigateway:POST",
          "apigateway:PUT",
          "apigateway:PATCH",
          "apigateway:DELETE",
        ],
        Resource: `arn:aws:apigateway:*::/restapis/*`,
      },
    );
  }
  if (customDomain) {
    common.push(
      { Effect: "Allow", Action: ["acm:ListCertificates"], Resource: "*" },
      {
        Effect: "Allow",
        Action: ["acm:RequestCertificate"],
        Resource: "*",
        Condition: {
          "ForAllValues:StringLike": {
            "acm:DomainNames": [customDomain, `*.${customDomain}`],
          },
        },
      },
      {
        Effect: "Allow",
        Action: [
          "acm:DescribeCertificate",
          "acm:DeleteCertificate",
          "acm:AddTagsToCertificate",
          "acm:RemoveTagsFromCertificate",
        ],
        Resource: `arn:aws:acm:us-east-1:${accountId}:certificate/*`,
      },
      {
        Effect: "Allow",
        Action: [
          "route53:ListHostedZonesByName",
          "route53:ListHostedZones",
          "route53:ListResourceRecordSets",
        ],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: ["route53:ChangeResourceRecordSets"],
        Resource: "arn:aws:route53:::hostedzone/*",
        Condition: {
          "ForAllValues:StringLike": {
            "route53:ChangeResourceRecordSetsNormalizedRecordNames": [
              customDomain,
              `*.${customDomain}`,
            ],
          },
        },
      },
    );
  }
  return { Version: "2012-10-17", Statement: common };
}

export function roleTrustPolicy(
  providerArn: string,
  production: boolean,
): object {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Federated: providerArn },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          StringLike: {
            "token.actions.githubusercontent.com:sub": production
              ? "repo:on-the-edge-cloud*:environment:production"
              : "repo:on-the-edge-cloud*:pull_request",
          },
        },
      },
    ],
  };
}

export function runtimeBoundaryPolicy(
  accountId: string,
  projectName: string,
): object {
  const statements = [
    {
      Effect: "Allow",
      Action: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ],
      Resource: `arn:aws:logs:*:${accountId}:log-group:/aws/*/${projectName}-*:*`,
    },
    {
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: `arn:aws:s3:::${projectName}-*/*`,
    },
    {
      Effect: "Allow",
      Action: ["s3:ListBucket", "s3:GetBucketLocation"],
      Resource: `arn:aws:s3:::${projectName}-*`,
    },
  ];
  return { Version: "2012-10-17", Statement: statements };
}

async function assumeAccountRole(
  managementClient: STSClient,
  accountId: string,
): Promise<IAMClient> {
  const credentials = await assumeOrganizationAccessRole(managementClient, accountId);
  return new IAMClient({
    credentials,
  });
}

export async function configureProjectRoles(
  managementClient: STSClient,
  accountId: string,
  projectName: string,
  appType: AppType,
  customDomain?: string,
): Promise<RoleNames> {
  const roles = roleNames(projectName);
  const iam = await assumeAccountRole(managementClient, accountId);
  const providers = await iam.send(new ListOpenIDConnectProvidersCommand({}));
  let providerArn = providers.OpenIDConnectProviderList?.find((provider) =>
    provider.Arn?.endsWith("/token.actions.githubusercontent.com"),
  )?.Arn;
  if (!providerArn) {
    const created = await iam.send(
      new CreateOpenIDConnectProviderCommand({
        Url: "https://token.actions.githubusercontent.com",
        ClientIDList: ["sts.amazonaws.com"],
        ThumbprintList: ["6938fd4d98bab03faadb97b34396831e3780aea1"],
        Tags: [{ Key: "ManagedBy", Value: "account-factory" }],
      }),
    );
    providerArn = created.OpenIDConnectProviderArn;
  } else {
    await iam.send(
      new GetOpenIDConnectProviderCommand({
        OpenIDConnectProviderArn: providerArn,
      }),
    );
  }
  if (!providerArn)
    throw new Error(
      "Could not create or find the GitHub Actions OIDC provider.",
    );

  if (appType === "ssr") {
    const boundary = await iam.send(
      new CreatePolicyCommand({
        PolicyName: `${projectName}-runtime-boundary`,
        Description: `Runtime permissions boundary for ${projectName}`,
        PolicyDocument: JSON.stringify(
          runtimeBoundaryPolicy(accountId, projectName),
        ),
        Tags: [
          { Key: "Project", Value: projectName },
          { Key: "ManagedBy", Value: "account-factory" },
        ],
      }),
    );
    if (!boundary.Policy?.Arn)
      throw new Error(
        `Could not create the ${projectName}-runtime-boundary permissions boundary.`,
      );
  }

  const policies = deploymentPolicy(
    accountId,
    projectName,
    appType,
    customDomain,
  );
  for (const [name, production] of [
    [roles.preview, false],
    [roles.production, true],
  ] as const) {
    await iam.send(
      new CreateRoleCommand({
        RoleName: name,
        AssumeRolePolicyDocument: JSON.stringify(
          roleTrustPolicy(providerArn, production),
        ),
        Description: `GitHub Actions ${production ? "production" : "preview"} deployment role for ${projectName}`,
        Tags: [
          { Key: "Project", Value: projectName },
          { Key: "ManagedBy", Value: "account-factory" },
        ],
      }),
    );
    await iam.send(
      new PutRolePolicyCommand({
        RoleName: name,
        PolicyName: `${projectName}-deployment`,
        PolicyDocument: JSON.stringify(policies),
      }),
    );
  }
  return roles;
}
