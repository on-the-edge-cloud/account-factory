# Account Factory

`account-factory` provisions AWS account identity and initializes or safely integrates a private project repository. It creates the AWS account, the GitHub Actions OIDC provider, and the preview/production deployment roles.

The factory does not deploy application resources. Project repositories own their infrastructure and deployment commands; `account-factory` supplies account permissions and the `nextjs-app.yml` manifest/workflow integration.

## Configure

Set the repository variable `AWS_ACCOUNT_FACTORY_ROLE_ARN` to the management-account role ARN. It must be assumable through GitHub Actions OIDC and allow `organizations:CreateAccount`, `organizations:DescribeCreateAccountStatus`, `organizations:TagResource`, `organizations:DescribeOrganization`, and `sts:AssumeRole` on `OrganizationAccountAccessRole` in newly created accounts. Static AWS access keys are not used.

Configure the GitHub App used by the factory with these repository permissions:

| Permission     | Access         | Purpose                                                                                   |
| -------------- | -------------- | ----------------------------------------------------------------------------------------- |
| Administration | Read and write | Create repositories, configure environments, and create/delete deployment branch policies |
| Actions        | Read-only      | List deployment branch policies                                                           |
| Secrets        | Read and write | Read repository public keys and write repository secrets                                  |
| Environments   | Read and write | Read environment public keys and write environment secrets                                |
| Contents       | Read and write | Inspect repositories and commit project files                                             |
| Workflows      | Read and write | Write caller workflows                                                                    |
| Metadata       | Read-only      | Read repository metadata                                                                  |

After changing App permissions, approve the update on the organization installation so newly generated tokens receive them. Install it on all current and future repositories in `on-the-edge-cloud`. In `on-the-edge-cloud/account-factory`, set the Actions variable `ACCOUNT_FACTORY_APP_CLIENT_ID` to the App's Client ID and the Actions secret `ACCOUNT_FACTORY_APP_PRIVATE_KEY` to its private key PEM. The workflow creates a short-lived installation token for each run; do not save that token as a repository secret.

If you plan to use custom domains, configure the organization secret `CLOUDFLARE_API_TOKEN` for `on-the-edge-cloud` and grant the `account-factory` repository access to it. The workflow passes it to the factory, which copies it into the new project's `production` environment only when a custom domain is requested.

## Configurar la cuenta de gestión

El bootstrap crea o actualiza `account-factory-github-bootstrap` en la cuenta de gestión `191926569765`. Su trust policy acepta únicamente `repo:on-the-edge-cloud@164330269/account-factory@1429556874:ref:refs/heads/main`, el subject OIDC observado en CloudTrail que incluye los IDs de la organización y del repositorio. Reutiliza el proveedor OIDC existente; no crea access keys ni acepta el subject antiguo sin IDs. Si cambia el formato OIDC, actualiza el subject exacto del bootstrap y vuelve a ejecutarlo antes de relanzar Create project.

También actualiza la política del bucket existente `on-the-edge-terraform-state`, verificando que pertenece a la cuenta de gestión. Conserva los statements ajenos y reemplaza únicamente los tres statements `AccountFactoryStateLocation`, `AccountFactoryStateList` y `AccountFactoryStateObjects`. Autoriza roles `github-actions-<Project>-preview/production` de la misma organización AWS, con tags `ManagedBy=account-factory` y `Project`, limitando sus objetos y listados al prefijo de ese proyecto. Incluye state y locks de proyectos static y SSR existentes y futuros. La sesión de CloudShell necesita permisos para consultar la organización y leer/actualizar la política S3, además de gestionar el rol IAM.

1. Abre AWS CloudShell con una sesión autenticada en la cuenta de gestión `191926569765`.
2. Copia [create-account-factory-bootstrap.sh](create-account-factory-bootstrap.sh) a CloudShell. Puedes crear el archivo con `nano create-account-factory-bootstrap.sh`, pegar el contenido y guardar con `Ctrl+O`, `Enter`, `Ctrl+X`.
3. Ejecútalo con `bash create-account-factory-bootstrap.sh`. El script verifica la cuenta activa y el proveedor OIDC antes de crear o actualizar el rol.
4. Copia el ARN que imprime al final.
5. En GitHub, abre **on-the-edge-cloud/account-factory → Settings → Secrets and variables → Actions → Variables**, crea `AWS_ACCOUNT_FACTORY_ROLE_ARN` y pega el ARN. Es una variable, no un secret.

Después, ejecuta **Actions → Create project → Run workflow** desde `main`. CloudShell usa las credenciales de la sesión autenticada; no hace falta configurar un perfil local ni access keys.

### Autorizar otras regiones

Para la SCP `p-im44ez6o` (`AdvancedModeRegionRestrictionSecurityControlPolicy`), copia [allow-project-regions.sh](allow-project-regions.sh) a CloudShell de la cuenta de gestión. La sesión necesita `organizations:DescribePolicy` y, para aplicar, `organizations:UpdatePolicy`.

```sh
bash allow-project-regions.sh
bash allow-project-regions.sh --apply
```

El primer comando solo muestra la propuesta; el segundo la aplica y verifica. Por defecto añade `eu-west-1`, `eu-central-1`, `eu-west-2`, `eu-west-3` y `eu-north-1`. Para otra selección, pasa regiones separadas por espacios, por ejemplo `bash allow-project-regions.sh --apply eu-west-1 eu-central-1`. Conserva todas las regiones previas y modifica solo la lista de `RegionFloor`. Guarda la política original y la propuesta en un directorio `region-policy-backup-*` de CloudShell, y no sobrescribe una política que haya cambiado desde su lectura.

El cambio afecta a todas las cuentas/OU que heredan esa SCP. No modifica las denegaciones específicas de `us-east-1`/`us-west-2`, otras SCP ni activa regiones opt-in. Si otra automatización administra esta política, alinea también su configuración de origen. AWS documenta la actualización de `RegionFloor` en [Activate advanced AWS features](https://docs.aws.amazon.com/accounts/latest/reference/activate-advanced-features.html). Tras aplicar, selecciona la región en Create project o actualiza el manifiesto de un proyecto existente y ejecuta su despliegue; el default de la fábrica sigue siendo `eu-north-1`.

## Create a project

Run **Actions > Create project > Run workflow** from `main`. Inputs include the kebab-case project name, `static` or `ssr`, optional custom domain, AWS region (default `eu-north-1` for both app types), and Node version. The CLI uses the same region by default. Select another region only if the organization's SCPs permit deployment there. Existing project manifests are not changed automatically; update their `app.aws-region` to `eu-north-1` if needed and rerun deployment, not account creation. Root emails use `fmoreno+<project_name>@ontheedge.cloud`.

AWS IAM limits role names to 64 characters. With the required `github-actions-<project_name>-production` name, the effective project-name limit is 38 characters even though the general input validation accepts up to 40; the factory rejects names that cannot form both required roles before creating an account.

The workflow reports the account ID, root email, both role ARNs, repository URL, file lists (`created` and `updated`), and final status. New static repos are generated from the [Next.js `with-static-export` example](https://github.com/vercel/next.js/tree/canary/examples/with-static-export); new SSR repos use the [official `create-next-app` template](https://github.com/vercel/next.js/blob/canary/packages/create-next-app/templates/index.ts). The factory adds a manifest and fixed caller workflows for [github-actions-nextjs](https://github.com/on-the-edge-cloud/github-actions-nextjs), then runs the generated build before creating an AWS account. Existing repos are cloned and their lint/test/typecheck/build scripts are run without AWS/GitHub credentials in the child process. A failed build aborts before account creation or push.

For an existing repo, application files are not overwritten. The standard `preview.yml` and `deploy.yml` are added or replaced at their standard paths. An existing `nextjs-app.yml` is merged while preserving unknown keys and comments. Changes are committed atomically only after preflight succeeds.

## Update an existing project (static / SSR)

Run **Actions > Update project > Run workflow** from `main`. Supply the existing repository name, its existing 12-digit AWS account ID, and the target type (`ssr` or `static`). For example, use `parking-management`, its current account ID, and `ssr` to repair the missing IAM/DynamoDB/SQS/Logs permissions without creating another account.

The workflow assumes `OrganizationAccountAccessRole` in that account using the same management role as Create project. That role must allow assuming access to existing project accounts too. Both deployment roles must already exist with matching account ARNs and `Project` / `ManagedBy=account-factory` tags. It replaces only their `<project>-deployment` inline policies with the current generator, including custom-domain permissions read from the manifest. Trust policies, OIDC providers, secrets, caller workflows, and application files are unchanged.

Only `app.deployment-type` is changed in `nextjs-app.yml`; all other settings and comments are preserved. The default branch must be `main` and the manifest slug must match the factory-generated slug. IAM updates finish before the manifest commit, which normally triggers the existing deployment caller. If the manifest already has the target type, policies are still refreshed without an empty commit: rerun the project's deployment workflow manually.

**This is not an infrastructure migration.** Static and SSR use separate Terraform states. Previous production/preview resources remain managed by their old state, are not destroyed, and can continue generating costs. Do not copy or delete state files. A custom domain already attached to the previous CloudFront distribution needs a separate, controlled cutover. Switching to static removes SSR deployment permissions; use an administrative role for later cleanup of retained SSR resources. Existing PR branches need their manifests updated separately.

Stop concurrent project deployments before updating. Prepare the application configuration separately: remove `output: "export"` for SSR features, or configure and validate static export before switching to static. This workflow does not build the application; the project deployment performs its normal build. There is no rollback across IAM and GitHub: if an update fails, inspect both role policies and the manifest, then retry with the same account. Do not rerun Create project.

Local equivalent, with management-account credentials and `ACCOUNT_FACTORY_GITHUB_TOKEN` configured:

```sh
PROJECT_NAME=parking-management ACCOUNT_ID=147777764287 APP_TYPE=ssr yarn update-project
```

## Project manifest and workflows

`nextjs-app.yml` follows the shared action's `app` config contract: slug, directory, Node version, AWS region, deployment type, and optional domain. The workflows call the shared production and preview reusable workflows, passing this config path; they are the same for static and SSR projects.

Generated callers use `github-actions-nextjs@v1.20`, which detects Yarn/npm and selects the corresponding lockfile for dependency caching and installation. New projects use Yarn and include `yarn.lock`. Existing projects generated with `v1.13` must update both caller workflow references to `v1.20`; rerun the deployment workflow, not account creation.

The factory configures GitHub Actions automatically: it sets the repository secret `AWS_ROLE_ARN` to the preview role ARN, creates the `production` environment restricted to the `main` branch, and sets its `AWS_ROLE_ARN` secret to the production role ARN. The environment request omits reviewer settings to avoid requesting a protection rule unsupported by some billing plans; existing reviewer rules are left unchanged. Private repositories still require a GitHub plan that supports environments and deployment branch policies. When a custom domain is requested, it also sets `CLOUDFLARE_API_TOKEN` in the production environment. The reusable workflows inherit these secrets and use GitHub OIDC.

GitHub environment/secret configuration happens after the AWS account and repository commit are created. If that final step fails, the error is surfaced, but the factory does not roll back those AWS or repository changes.

The shared workflows keep Terraform state in the cross-account S3 bucket `on-the-edge-terraform-state` (region `eu-north-1`) under `nextjs/on-the-edge-cloud/<repository>/`. The generated roles receive identity permissions for that repository's state prefix. Run the updated bootstrap once in the management account to configure the corresponding bucket-side access, including for previously created projects; then rerun their deployment workflow, not account creation. Existing explicit denies still apply. If the bucket uses SSE-KMS, the KMS key policy and deployment roles also need encryption/decryption permissions; this bootstrap does not modify KMS policies.

For SSR, the current Terraform module does not attach a permissions boundary to its Lambda execution roles. Accordingly, the generated deployment role can create and manage inline policies on roles whose names start with the app slug, and pass those roles only to Lambda. A permissions boundary should only be enforced after the shared Terraform module supports attaching it.

SSR policies also allow Terraform to list attached IAM role policies, read DynamoDB continuous-backup and TTL settings (even when not configured), and read/manage CloudWatch log-group tags, scoped to project resources. If an existing SSR deployment fails on these permissions, publish the factory changes, rerun **Update project** with the same account and `ssr`, then rerun the project's deployment. No manifest commit is needed when it already specifies SSR. An apply that failed during resource reads may have created resources; preserve the existing state and inspect the next plan rather than deleting or recreating them blindly.

Deployment policies include S3 acceleration, lifecycle, replication, and encryption configuration reads for project buckets, plus `s3:PutEncryptionConfiguration` and object tag read/write/delete permissions. These IAM action names are not covered by `s3:GetBucket*`, `s3:PutBucket*`, or the basic object read/write actions. Changes to generated deployment policies do not update existing roles automatically; update their inline policies before retrying deployment. A failed Terraform apply may leave resources created, so inspect the remote state before importing or recreating a bucket.

## Development

```sh
yarn install --frozen-lockfile
yarn lint
yarn format:check
yarn test
yarn typecheck
```
