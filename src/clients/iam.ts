import {
  CreateOpenIDConnectProviderCommand,
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
  const slug = projectSlug(projectName);
  const statePrefix = `nextjs/on-the-edge-cloud/${projectName}/`;
  const appBucketArn = `arn:aws:s3:::${slug}*`;
  const appBucketObjectsArn = `${appBucketArn}/*`;
  const statements: Array<Record<string, unknown>> = [
    {
      Effect: "Allow",
      Action: ["s3:GetBucketLocation"],
      Resource: "arn:aws:s3:::on-the-edge-terraform-state",
    },
    {
      Effect: "Allow",
      Action: ["s3:ListBucket"],
      Resource: "arn:aws:s3:::on-the-edge-terraform-state",
      Condition: { StringLike: { "s3:prefix": [`${statePrefix}*`] } },
    },
    {
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: `arn:aws:s3:::on-the-edge-terraform-state/${statePrefix}*`,
    },
    {
      Effect: "Allow",
      Action: [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:GetBucket*",
        "s3:PutBucket*",
        "s3:DeleteBucket*",
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts",
      ],
      Resource: [appBucketArn, appBucketObjectsArn],
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
        "cloudfront:CreateInvalidation",
        "cloudfront:GetInvalidation",
        "cloudfront:CreateOriginAccessControl",
        "cloudfront:UpdateOriginAccessControl",
        "cloudfront:DeleteOriginAccessControl",
        "cloudfront:GetOriginAccessControl",
        "cloudfront:ListOriginAccessControls",
        "cloudfront:GetOriginRequestPolicy",
        "cloudfront:ListOriginRequestPolicies",
        "cloudfront:CreateFunction",
        "cloudfront:UpdateFunction",
        "cloudfront:DeleteFunction",
        "cloudfront:DescribeFunction",
        "cloudfront:PublishFunction",
        "cloudfront:GetFunction",
        "cloudfront:ListFunctions",
        "cloudfront:CreateCachePolicy",
        "cloudfront:UpdateCachePolicy",
        "cloudfront:DeleteCachePolicy",
        "cloudfront:GetCachePolicy",
        "cloudfront:ListCachePolicies",
        "cloudfront:TagResource",
        "cloudfront:UntagResource",
        "cloudfront:ListTagsForResource",
      ],
      Resource: "*",
    },
    { Effect: "Allow", Action: ["sts:GetCallerIdentity"], Resource: "*" },
  ];

  statements.push({
    Effect: "Allow",
    Action: ["iam:CreateServiceLinkedRole"],
    Resource: "*",
    Condition: {
      StringEquals: { "iam:AWSServiceName": "cloudfront.amazonaws.com" },
    },
  });

  if (appType === "ssr") {
    statements.push(
      {
        Effect: "Allow",
        Action: [
          "logs:CreateLogGroup",
          "logs:DeleteLogGroup",
          "logs:PutRetentionPolicy",
          "logs:DeleteRetentionPolicy",
        ],
        Resource: `arn:aws:logs:*:${accountId}:log-group:/aws/lambda/${slug}*`,
      },
      {
        Effect: "Allow",
        Action: ["logs:DescribeLogGroups"],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:GetRole",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:ListRoleTags",
          "iam:ListRolePolicies",
          "iam:PutRolePolicy",
          "iam:GetRolePolicy",
          "iam:DeleteRolePolicy",
        ],
        Resource: `arn:aws:iam::${accountId}:role/${slug}*`,
      },
      {
        Effect: "Allow",
        Action: ["iam:PassRole"],
        Resource: `arn:aws:iam::${accountId}:role/${slug}*`,
        Condition: {
          StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" },
        },
      },
      {
        Effect: "Allow",
        Action: [
          "lambda:CreateFunction",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:DeleteFunction",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:GetPolicy",
          "lambda:ListTags",
          "lambda:AddPermission",
          "lambda:RemovePermission",
          "lambda:TagResource",
          "lambda:UntagResource",
          "lambda:CreateFunctionUrlConfig",
          "lambda:UpdateFunctionUrlConfig",
          "lambda:DeleteFunctionUrlConfig",
          "lambda:GetFunctionUrlConfig",
          "lambda:InvokeFunction",
        ],
        Resource: `arn:aws:lambda:*:${accountId}:function:${slug}*`,
      },
      {
        Effect: "Allow",
        Action: [
          "lambda:CreateEventSourceMapping",
          "lambda:DeleteEventSourceMapping",
          "lambda:GetEventSourceMapping",
          "lambda:UpdateEventSourceMapping",
        ],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: [
          "dynamodb:CreateTable",
          "dynamodb:DeleteTable",
          "dynamodb:DescribeTable",
          "dynamodb:UpdateTable",
          "dynamodb:ListTagsOfResource",
          "dynamodb:TagResource",
          "dynamodb:UntagResource",
        ],
        Resource: [
          `arn:aws:dynamodb:*:${accountId}:table/${slug}*`,
          `arn:aws:dynamodb:*:${accountId}:table/${slug}*/index/*`,
        ],
      },
      {
        Effect: "Allow",
        Action: [
          "sqs:CreateQueue",
          "sqs:DeleteQueue",
          "sqs:GetQueueUrl",
          "sqs:GetQueueAttributes",
          "sqs:SetQueueAttributes",
          "sqs:TagQueue",
          "sqs:UntagQueue",
          "sqs:ListQueueTags",
        ],
        Resource: `arn:aws:sqs:*:${accountId}:${slug}*`,
      },
    );
  }
  if (customDomain) {
    statements.push(
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
          "acm:ListTagsForCertificate",
        ],
        Resource: `arn:aws:acm:us-east-1:${accountId}:certificate/*`,
      },
    );
  }
  return { Version: "2012-10-17", Statement: statements };
}

function projectSlug(projectName: string): string {
  return projectName.toLowerCase().slice(0, 24).replace(/-+$/g, "");
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

async function assumeAccountRole(
  managementClient: STSClient,
  accountId: string,
): Promise<IAMClient> {
  const credentials = await assumeOrganizationAccessRole(
    managementClient,
    accountId,
  );
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
