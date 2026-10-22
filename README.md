# Account Factory

`account-factory` provisions AWS account identity and bootstraps a private project repository. It creates the AWS account, GitHub Actions OIDC provider and preview/production roles, then commits the deployment templates to the new repository.

The factory does **not** create application infrastructure. Each generated repository owns and deploys its own resources through its `preview.yml` and `deploy.yml` workflows using the roles created for that project.

## Configure

Set the repository variable `AWS_ACCOUNT_FACTORY_ROLE_ARN` to the management-account role ARN. That role must be assumable through GitHub Actions OIDC and allow `organizations:CreateAccount`, `organizations:DescribeCreateAccountStatus`, `organizations:TagResource`, `organizations:DescribeOrganization`, and `sts:AssumeRole` on `OrganizationAccountAccessRole` in newly created accounts.

Create the repository secret `ACCOUNT_FACTORY_GITHUB_TOKEN` with permission to create private repositories in `on-the-edge-cloud` and write their initial contents. Static AWS access keys are not used.

Install dependencies with `yarn install`, then run `yarn test` and `yarn typecheck`.

## Create a project

Run **Actions > Create project > Run workflow**. Use a lowercase kebab-case name of up to 38 characters, select `static` or `ssr`, and optionally provide a DNS hostname. The effective 38-character maximum keeps both required role names within AWS's 64-character IAM role-name limit. AWS root emails are generated as `fmoreno+<project_name>@ontheedge.cloud`.

The workflow publishes these outputs: AWS account ID, root email, preview role ARN, production role ARN, repository URL, and final status. It also adds `.github/workflows/preview.yml`, `.github/workflows/deploy.yml`, `nextjs-app.yml`, and an SST configuration to the new repo.

The generated roles trust only the matching repository: the preview role accepts pull requests and branches, while the production role accepts pushes to `main`. Their inline policies vary by app type and scope CloudFormation, S3, IAM, logging, and CloudFront access to the project; SSR adds Lambda, API Gateway, SQS, and DynamoDB permissions.