# Account Factory

`account-factory` provisions AWS account identity and initializes or safely integrates a private project repository. It creates the AWS account, the GitHub Actions OIDC provider, and the preview/production deployment roles.

The factory does not deploy application resources. Project repositories own their infrastructure and deployment commands; `account-factory` supplies account permissions and the `nextjs-app.yml` manifest/workflow integration.

## Configure

Set the repository variable `AWS_ACCOUNT_FACTORY_ROLE_ARN` to the management-account role ARN. It must be assumable through GitHub Actions OIDC and allow `organizations:CreateAccount`, `organizations:DescribeCreateAccountStatus`, `organizations:TagResource`, `organizations:DescribeOrganization`, and `sts:AssumeRole` on `OrganizationAccountAccessRole` in newly created accounts. Static AWS access keys are not used.

Create `ACCOUNT_FACTORY_GITHUB_TOKEN` as a fine-grained token or GitHub App token with organization access and repository `Administration: read/write`, `Contents: read/write`, `Workflows: read/write`, and `Metadata: read`. It must be able to list private organization repositories; a GitHub 404 is otherwise ambiguous between a missing repo and inaccessible private repo.

The generated production workflow declares the GitHub Environment `production`. A repository administrator must configure that environment with required reviewers and any deployment branch restrictions before production use; reviewer identities are not guessed or created by the factory.

## Create a project

Run **Actions > Create project > Run workflow** from `main`. Inputs include the kebab-case project name, `static` or `ssr`, optional custom domain, AWS region, and Node version. Root emails use `fmoreno+<project_name>@ontheedge.cloud`.

AWS IAM limits role names to 64 characters. With the required `github-actions-<project_name>-production` name, the effective project-name limit is 38 characters even though the general input validation accepts up to 40; the factory rejects names that cannot form both required roles before creating an account.

The workflow reports the account ID, root email, both role ARNs, repository URL, file lists (`created`, `updated`, `ignored`), and final status. New repos receive a TypeScript App Router Next.js/Yarn scaffold. Existing repos are cloned, their package manager and scripts are detected, and lint/tests/typecheck/build scripts are run without AWS/GitHub credentials in the child process. A failed build aborts before account creation or push.

For an existing repo, application files and existing workflows are not overwritten. Missing workflows are added; if `preview.yml` or `deploy.yml` already exists, the integration uses `aws-preview.yml` or `aws-deploy.yml` and reports the original as ignored. An existing `nextjs-app.yml` is merged while preserving unknown keys and comments. Changes are committed atomically only after preflight succeeds.

## Project manifest and workflows

`nextjs-app.yml` is YAML configuration rooted at `app:`, including `aws-region`, `deployment-type`, `deployment-strategy`, account/email/role values, `domain`, package manager, Node version, output directory, and project-owned commands. When no domain is supplied, `domain` is explicitly `null`; domain projects declare ACM and Route 53.

Project workflows read the manifest. Preview OIDC is restricted to the `pull_request` subject and the preview job has no GitHub Environment. A manual preview dispatch runs validation/build only and does not deploy: a manual dispatch has a `ref` subject, which the required preview trust policy intentionally does not accept. Production runs on the default branch/`main`, declares `environment: production`, and assumes the production role.

## Development

```sh
yarn install --frozen-lockfile
yarn lint
yarn format:check
yarn test
yarn typecheck
```
