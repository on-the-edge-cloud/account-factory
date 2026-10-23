#!/usr/bin/env bash
set -euo pipefail

# ==== CONFIGURATION ====
MANAGEMENT_ACCOUNT_ID="191926569765"
GITHUB_ORG="on-the-edge-cloud"
GITHUB_REPO="account-factory"
GITHUB_BRANCH="main"

ROLE_NAME="account-factory-github-bootstrap"
POLICY_NAME="account-factory-bootstrap-minimum"

OIDC_PROVIDER_ARN="arn:aws:iam::191926569765:oidc-provider/token.actions.githubusercontent.com"
OIDC_AUDIENCE="sts.amazonaws.com"

for command in aws jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "ERROR: required command '$command' is not installed." >&2
    exit 1
  fi
done

CURRENT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$CURRENT_ACCOUNT" != "$MANAGEMENT_ACCOUNT_ID" ]]; then
  echo "ERROR: current AWS account is $CURRENT_ACCOUNT." >&2
  echo "Run this script from management account $MANAGEMENT_ACCOUNT_ID." >&2
  exit 1
fi

OIDC_PROVIDER="$(aws iam get-open-id-connect-provider \
  --open-id-connect-provider-arn "$OIDC_PROVIDER_ARN")"
if ! jq -e --arg audience "$OIDC_AUDIENCE" '.ClientIDList | index($audience) != null' \
  <<<"$OIDC_PROVIDER" >/dev/null; then
  echo "ERROR: the existing OIDC provider does not trust audience $OIDC_AUDIENCE." >&2
  exit 1
fi

echo "Using existing GitHub OIDC provider:"
echo "  $OIDC_PROVIDER_ARN"

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
TRUST_POLICY_FILE="$TEMP_DIR/trust-policy.json"
PERMISSIONS_POLICY_FILE="$TEMP_DIR/permissions-policy.json"

GITHUB_SUB="repo:${GITHUB_ORG}/${GITHUB_REPO}:ref:refs/heads/${GITHUB_BRANCH}"
jq -n \
  --arg provider "$OIDC_PROVIDER_ARN" \
  --arg audience "$OIDC_AUDIENCE" \
  --arg subject "$GITHUB_SUB" \
  '{
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Federated: $provider },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": $audience,
          "token.actions.githubusercontent.com:sub": $subject
        }
      }
    }]
  }' > "$TRUST_POLICY_FILE"

cat > "$PERMISSIONS_POLICY_FILE" <<'POLICY'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CreateAndInspectProjectAccounts",
      "Effect": "Allow",
      "Action": [
        "organizations:CreateAccount",
        "organizations:DescribeCreateAccountStatus",
        "organizations:TagResource",
        "organizations:DescribeOrganization"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ConfigureNewProjectAccount",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::*:role/OrganizationAccountAccessRole"
    }
  ]
}
POLICY

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "Role $ROLE_NAME already exists; updating its trust policy."
  aws iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document "file://$TRUST_POLICY_FILE"
else
  echo "Creating role $ROLE_NAME..."
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://$TRUST_POLICY_FILE" \
    --description "GitHub Actions bootstrap role for account-factory" \
    --tags \
      Key=Project,Value=account-factory \
      Key=ManagedBy,Value=github-actions \
    --query Role.Arn \
    --output text
fi

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "file://$PERMISSIONS_POLICY_FILE"

ROLE_ARN="arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/${ROLE_NAME}"

echo
echo "Bootstrap role is ready:"
echo "  $ROLE_ARN"
echo
echo "Set this repository variable in ${GITHUB_ORG}/${GITHUB_REPO}:"
echo "AWS_ACCOUNT_FACTORY_ROLE_ARN=$ROLE_ARN"
