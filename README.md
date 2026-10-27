# Account Factory

`account-factory` provisions AWS account identity and initializes or safely integrates a private project repository. It creates the AWS account, the GitHub Actions OIDC provider, and the preview/production deployment roles.

The factory does not deploy application resources. Project repositories own their infrastructure and deployment commands; `account-factory` supplies account permissions and the `nextjs-app.yml` manifest/workflow integration.

## Configure

Set the repository variable `AWS_ACCOUNT_FACTORY_ROLE_ARN` to the management-account role ARN. It must be assumable through GitHub Actions OIDC and allow `organizations:CreateAccount`, `organizations:DescribeCreateAccountStatus`, `organizations:TagResource`, `organizations:DescribeOrganization`, and `sts:AssumeRole` on `OrganizationAccountAccessRole` in newly created accounts. Static AWS access keys are not used.

Create `ACCOUNT_FACTORY_GITHUB_TOKEN` as a fine-grained token or GitHub App token with organization access and repository `Administration: read/write`, `Contents: read/write`, `Workflows: read/write`, and `Metadata: read`. It must be able to list private organization repositories; a GitHub 404 is otherwise ambiguous between a missing repo and inaccessible private repo.

The generated production workflow declares the GitHub Environment `production`. A repository administrator must configure that environment with required reviewers and any deployment branch restrictions before production use; reviewer identities are not guessed or created by the factory.

## Configurar la cuenta de gestión

El bootstrap crea o actualiza `account-factory-github-bootstrap` en la cuenta de gestión `191926569765`. Su trust policy acepta únicamente `repo:on-the-edge-cloud/account-factory:ref:refs/heads/main` y reutiliza el proveedor OIDC existente; no crea access keys.

1. Abre AWS CloudShell con una sesión autenticada en la cuenta de gestión `191926569765`.
2. Copia [create-account-factory-bootstrap.sh](create-account-factory-bootstrap.sh) a CloudShell. Puedes crear el archivo con `nano create-account-factory-bootstrap.sh`, pegar el contenido y guardar con `Ctrl+O`, `Enter`, `Ctrl+X`.
3. Ejecútalo con `bash create-account-factory-bootstrap.sh`. El script verifica la cuenta activa y el proveedor OIDC antes de crear o actualizar el rol.
4. Copia el ARN que imprime al final.
5. En GitHub, abre **on-the-edge-cloud/account-factory → Settings → Secrets and variables → Actions → Variables**, crea `AWS_ACCOUNT_FACTORY_ROLE_ARN` y pega el ARN. Es una variable, no un secret.

Después, ejecuta **Actions → Create project → Run workflow** desde `main`. CloudShell usa las credenciales de la sesión autenticada; no hace falta configurar un perfil local ni access keys.

### Troubleshooting bootstrap OIDC authentication

If `aws-actions/configure-aws-credentials` fails with `Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity`, project creation has not started. AWS rejected the bootstrap role assumption; the error alone does not identify which live IAM setting is wrong. The workflow already requests `id-token: write`.

In an authenticated management-account CloudShell session, inspect the deployed role and provider:

```sh
aws sts get-caller-identity --query Account --output text
aws iam get-role --role-name account-factory-github-bootstrap \
  --query 'Role.{Arn:Arn,Trust:AssumeRolePolicyDocument}'
aws iam get-open-id-connect-provider \
  --open-id-connect-provider-arn arn:aws:iam::191926569765:oidc-provider/token.actions.githubusercontent.com
```

Verify that the account is `191926569765`, `AWS_ACCOUNT_FACTORY_ROLE_ARN` matches the returned role ARN, and the role trusts that OIDC provider for `sts:AssumeRoleWithWebIdentity` with these exact conditions:

- `token.actions.githubusercontent.com:aud`: `sts.amazonaws.com`
- `token.actions.githubusercontent.com:sub`: `repo:on-the-edge-cloud/account-factory:ref:refs/heads/main`

The provider's `ClientIDList` must include `sts.amazonaws.com`. If the role is missing or its trust policy differs, run the current `create-account-factory-bootstrap.sh` in that session. It creates a missing role or updates an existing role's trust policy; it first verifies the account and provider audience. Correct any provider validation error before rerunning it, then set the repository variable to the printed ARN and run **Create project** from `main` again.

This repair must be applied in AWS; merging repository changes or retrying the unchanged job does not update IAM. Do not remove the subject condition, replace it with a wildcard, or add static AWS keys. If the deployed policy already matches, check whether organization/repository OIDC subject customization changes the issued `sub`, and whether AWS organization policies explicitly deny the assumption.

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
