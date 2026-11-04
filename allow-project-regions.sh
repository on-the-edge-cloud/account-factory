#!/usr/bin/env bash
set -euo pipefail
umask 077

MANAGEMENT_ACCOUNT_ID="191926569765"
POLICY_ID="p-im44ez6o"
DEFAULT_REGIONS=(eu-west-1 eu-central-1 eu-west-2 eu-west-3 eu-north-1)
APPLY=false
REGIONS=()

for argument in "$@"; do
  case "$argument" in
    --apply) APPLY=true ;;
    --help)
      echo "Usage: bash allow-project-regions.sh [--apply] [region ...]"
      echo "Without --apply, only saves a backup and previews the policy."
      exit 0
      ;;
    *)
      if [[ ! "$argument" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]]; then
        echo "ERROR: invalid region argument: $argument" >&2
        exit 1
      fi
      REGIONS+=("$argument")
      ;;
  esac
done
if [[ ${#REGIONS[@]} -eq 0 ]]; then
  REGIONS=("${DEFAULT_REGIONS[@]}")
fi

for command in aws jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "ERROR: required command '$command' is not installed." >&2
    exit 1
  fi
done

CURRENT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text --no-cli-pager)"
if [[ "$CURRENT_ACCOUNT" != "$MANAGEMENT_ACCOUNT_ID" ]]; then
  echo "ERROR: run this script from management account $MANAGEMENT_ACCOUNT_ID." >&2
  exit 1
fi

BACKUP_DIR="$(mktemp -d "$PWD/region-policy-backup-XXXXXX")"
aws organizations describe-policy --policy-id "$POLICY_ID" --output json --no-cli-pager \
  > "$BACKUP_DIR/original-response.json"
jq -e --arg id "$POLICY_ID" '
  .Policy.PolicySummary |
  .Id == $id and .Type == "SERVICE_CONTROL_POLICY" and
  .AwsManaged == false and .Name == "AdvancedModeRegionRestrictionSecurityControlPolicy"
' "$BACKUP_DIR/original-response.json" >/dev/null || {
  echo "ERROR: unexpected policy metadata; no policy was changed." >&2
  exit 1
}
jq -r '.Policy.Content' "$BACKUP_DIR/original-response.json" > "$BACKUP_DIR/original.json"
jq -e '
  .Version == "2012-10-17" and
  (.Statement | type == "array") and
  ([.Statement[] | select(.Sid == "RegionFloor")] | length == 1) and
  ([.Statement[] | select(.Sid == "RegionFloor")][0] |
    .Effect == "Deny" and .Resource == "*" and
    (.NotAction | type == "array") and
    (.Condition | keys == ["StringNotEquals"]) and
    (.Condition.StringNotEquals | keys == ["aws:RequestedRegion"]) and
    (.Condition.StringNotEquals["aws:RequestedRegion"] |
      type == "array" and length > 0 and all(.[]; type == "string")))
' "$BACKUP_DIR/original.json" >/dev/null || {
  echo "ERROR: unexpected RegionFloor structure; no policy was changed." >&2
  exit 1
}

REGIONS_JSON="$(printf '%s\n' "${REGIONS[@]}" | jq -R . | jq -s .)"
jq --argjson regions "$REGIONS_JSON" '
  .Statement |= map(
    if .Sid == "RegionFloor" then
      .Condition.StringNotEquals["aws:RequestedRegion"] |=
        reduce $regions[] as $region (.;
          if index($region) == null then . + [$region] else . end)
    else . end
  )
' "$BACKUP_DIR/original.json" > "$BACKUP_DIR/updated.json"

echo "Policy backup and proposed update: $BACKUP_DIR"
echo "RegionFloor regions:"
jq '.Statement[] | select(.Sid == "RegionFloor") |
  .Condition.StringNotEquals["aws:RequestedRegion"]' "$BACKUP_DIR/updated.json"
echo "This affects every account/OU inheriting this policy; other restrictions remain unchanged."

if [[ "$(jq -Sc . "$BACKUP_DIR/original.json")" == "$(jq -Sc . "$BACKUP_DIR/updated.json")" ]]; then
  echo "All requested regions are already included; no update is needed."
  exit 0
fi
if [[ "$APPLY" != true ]]; then
  echo "Preview only. Rerun with --apply and the same region arguments to update AWS."
  exit 0
fi

CURRENT_POLICY="$(aws organizations describe-policy --policy-id "$POLICY_ID" \
  --query Policy.Content --output text --no-cli-pager)"
if [[ "$(jq -Sc . <<<"$CURRENT_POLICY")" != "$(jq -Sc . "$BACKUP_DIR/original.json")" ]]; then
  echo "ERROR: policy changed since it was read; refusing to overwrite newer changes." >&2
  exit 1
fi
aws organizations update-policy --policy-id "$POLICY_ID" \
  --content "file://$BACKUP_DIR/updated.json" --no-cli-pager > "$BACKUP_DIR/update-response.json"
aws organizations describe-policy --policy-id "$POLICY_ID" \
  --query Policy.Content --output text --no-cli-pager > "$BACKUP_DIR/verified.json"
if [[ "$(jq -Sc . "$BACKUP_DIR/verified.json")" != "$(jq -Sc . "$BACKUP_DIR/updated.json")" ]]; then
  echo "ERROR: policy update could not be verified; inspect AWS and the backup before retrying." >&2
  exit 1
fi
echo "Policy updated and verified. Rerun deployment, not account creation."
