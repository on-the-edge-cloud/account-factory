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

## Create a project

Run **Actions > Create project > Run workflow** from `main`. Inputs include the kebab-case project name, `static` or `ssr`, optional custom domain, AWS region, and Node version. Root emails use `fmoreno+<project_name>@ontheedge.cloud`.

AWS IAM limits role names to 64 characters. With the required `github-actions-<project_name>-production` name, the effective project-name limit is 38 characters even though the general input validation accepts up to 40; the factory rejects names that cannot form both required roles before creating an account.

The workflow reports the account ID, root email, both role ARNs, repository URL, file lists (`created` and `updated`), and final status. New static repos are generated from the [Next.js `with-static-export` example](https://github.com/vercel/next.js/tree/canary/examples/with-static-export); new SSR repos use the [official `create-next-app` template](https://github.com/vercel/next.js/blob/canary/packages/create-next-app/templates/index.ts). The factory adds a manifest and fixed caller workflows for [github-actions-nextjs](https://github.com/on-the-edge-cloud/github-actions-nextjs), then runs the generated build before creating an AWS account. Existing repos are cloned and their lint/test/typecheck/build scripts are run without AWS/GitHub credentials in the child process. A failed build aborts before account creation or push.

For an existing repo, application files are not overwritten. The standard `preview.yml` and `deploy.yml` are added or replaced at their standard paths. An existing `nextjs-app.yml` is merged while preserving unknown keys and comments. Changes are committed atomically only after preflight succeeds.

## Project manifest and workflows

`nextjs-app.yml` follows the shared action's `app` config contract: slug, directory, Node version, AWS region, deployment type, and optional domain. The workflows call the shared production and preview reusable workflows, passing this config path; they are the same for static and SSR projects.

Configure the repository secret `AWS_ROLE_ARN` with the preview role ARN, and the `production` environment secret of the same name with the production role ARN. The reusable workflows inherit secrets and use GitHub OIDC. For custom domains, also configure `CLOUDFLARE_API_TOKEN` in the `production` environment.

The shared workflows keep Terraform state in the cross-account S3 bucket `on-the-edge-terraform-state` (region `eu-north-1`) under `nextjs/on-the-edge-cloud/<repository>/`. The generated roles receive identity permissions for that repository's state prefix. The bucket owner's S3 bucket policy must also allow the preview and production role ARNs to get the bucket location, list that prefix, and read, write, and delete objects there.

For SSR, the current Terraform module does not attach a permissions boundary to its Lambda execution roles. Accordingly, the generated deployment role can create and manage inline policies on roles whose names start with the app slug, and pass those roles only to Lambda. A permissions boundary should only be enforced after the shared Terraform module supports attaching it.

## Development

```sh
yarn install --frozen-lockfile
yarn lint
yarn format:check
yarn test
yarn typecheck
```
