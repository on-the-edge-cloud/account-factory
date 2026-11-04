import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("management bootstrap state bucket access", () => {
  it("preserves unrelated policy rules and applies idempotent project isolation", () => {
    const directory = mkdtempSync(join(tmpdir(), "factory-bootstrap-test-"));
    try {
      const policyPath = join(directory, "policy.json");
      writeFileSync(
        policyPath,
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [{ Sid: "ExistingRule", Effect: "Deny", Resource: "*" }],
        }),
      );
      const awsPath = join(directory, "aws");
      writeFileSync(
        awsPath,
        `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "sts get-caller-identity") echo 191926569765 ;;
  "iam get-open-id-connect-provider") echo '{"ClientIDList":["sts.amazonaws.com"]}' ;;
  "organizations describe-organization") echo o-example123 ;;
  "s3api head-bucket") ;;
  "s3api get-bucket-policy")
    if [[ "\${POLICY_ERROR:-}" == "missing" ]]; then
      echo 'An error occurred (NoSuchBucketPolicy)' >&2
      exit 1
    elif [[ "\${POLICY_ERROR:-}" == "denied" ]]; then
      echo 'An error occurred (AccessDenied)' >&2
      exit 1
    fi
    cat "$TEST_POLICY"
    ;;
  "s3api put-bucket-policy")
    for argument in "$@"; do
      if [[ "$argument" == file://* ]]; then
        cp "\${argument#file://}" "$TEST_POLICY"
      fi
    done
    ;;
  "iam update-assume-role-policy")
    for argument in "$@"; do
      if [[ "$argument" == file://* ]]; then
        cp "\${argument#file://}" "$TEST_TRUST"
      fi
    done
    ;;
  "iam get-role"|"iam put-role-policy") ;;
  *) echo "Unexpected AWS operation: $1 $2" >&2; exit 1 ;;
esac
`,
      );
      chmodSync(awsPath, 0o700);
      const script = resolve("create-account-factory-bootstrap.sh");
      const environment = {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        TEST_POLICY: policyPath,
        TEST_TRUST: join(directory, "trust.json"),
      };
      const run = (policyError = "") =>
        execFileSync("bash", [script], {
          env: { ...environment, POLICY_ERROR: policyError },
          stdio: "pipe",
        });

      run();
      const trust = JSON.parse(readFileSync(environment.TEST_TRUST, "utf8"));
      expect(trust.Statement).toHaveLength(1);
      expect(trust.Statement[0]).toEqual({
        Effect: "Allow",
        Principal: {
          Federated:
            "arn:aws:iam::191926569765:oidc-provider/token.actions.githubusercontent.com",
        },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub":
              "repo:on-the-edge-cloud@164330269/account-factory@1429556874:ref:refs/heads/main",
          },
        },
      });
      const firstPolicy = readFileSync(policyPath, "utf8");
      const policy = JSON.parse(firstPolicy);
      expect(policy.Statement).toHaveLength(4);
      expect(policy.Statement[0].Sid).toBe("ExistingRule");
      const objects = policy.Statement[3];
      expect(objects.Resource).toBe(
        "arn:aws:s3:::on-the-edge-terraform-state/nextjs/on-the-edge-cloud/${aws:PrincipalTag/Project}/*",
      );
      expect(objects.Condition.StringEquals).toEqual({
        "aws:PrincipalOrgID": "o-example123",
        "aws:PrincipalTag/ManagedBy": "account-factory",
      });
      expect(objects.Condition.ArnLike["aws:PrincipalArn"]).toEqual([
        "arn:aws:iam::*:role/github-actions-${aws:PrincipalTag/Project}-preview",
        "arn:aws:iam::*:role/github-actions-${aws:PrincipalTag/Project}-production",
      ]);
      expect(objects.Action).toEqual([
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
      ]);
      expect(policy.Statement[2].Condition.StringLike["s3:prefix"]).toEqual([
        "nextjs/on-the-edge-cloud/${aws:PrincipalTag/Project}/*",
      ]);
      run();
      expect(readFileSync(policyPath, "utf8")).toBe(firstPolicy);
      expect(() => run("denied")).toThrow();
      expect(readFileSync(policyPath, "utf8")).toBe(firstPolicy);
      run("missing");
      expect(
        JSON.parse(readFileSync(policyPath, "utf8")).Statement,
      ).toHaveLength(3);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
