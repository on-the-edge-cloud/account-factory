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

describe("region restriction update", () => {
  it("previews, backs up, and adds regions without changing other restrictions", () => {
    const directory = mkdtempSync(join(tmpdir(), "factory-regions-test-"));
    try {
      const policyPath = join(directory, "policy.json");
      const original = {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "UsEast1Partitional",
            Effect: "Deny",
            NotAction: ["cloudfront:*"],
            Resource: "*",
            Condition: { StringEquals: { "aws:RequestedRegion": "us-east-1" } },
          },
          {
            Sid: "RegionFloor",
            Effect: "Deny",
            NotAction: ["bedrock:InvokeModel"],
            Resource: "*",
            Condition: {
              StringNotEquals: {
                "aws:RequestedRegion": [
                  "eu-north-1",
                  "unspecified",
                  "us-east-1",
                  "us-west-2",
                ],
              },
            },
          },
        ],
      };
      writeFileSync(policyPath, JSON.stringify(original));
      const awsPath = join(directory, "aws");
      writeFileSync(
        awsPath,
        `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "sts get-caller-identity") echo "\${TEST_ACCOUNT:-191926569765}" ;;
  "organizations describe-policy")
    if [[ "$*" == *"Policy.Content"* ]]; then
      cat "$TEST_POLICY"
    else
      jq -n --arg content "$(cat "$TEST_POLICY")" '{
        Policy: {
          PolicySummary: {
            Id: "p-im44ez6o", Type: "SERVICE_CONTROL_POLICY",
            AwsManaged: false, Name: "AdvancedModeRegionRestrictionSecurityControlPolicy"
          },
          Content: $content
        }
      }'
    fi
    ;;
  "organizations update-policy")
    if [[ "\${TEST_DENY:-}" == "true" ]]; then
      echo AccessDenied >&2
      exit 1
    fi
    for argument in "$@"; do
      if [[ "$argument" == file://* ]]; then
        cp "\${argument#file://}" "$TEST_POLICY"
      fi
    done
    echo '{}'
    ;;
  *) echo "Unexpected AWS operation: $1 $2" >&2; exit 1 ;;
esac
`,
      );
      chmodSync(awsPath, 0o700);
      const script = resolve("allow-project-regions.sh");
      const run = (args: string[] = [], env = {}) =>
        execFileSync("bash", [script, ...args], {
          cwd: directory,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            TEST_POLICY: policyPath,
            ...env,
          },
          encoding: "utf8",
          stdio: "pipe",
        });
      expect(run()).toContain("Preview only");
      expect(JSON.parse(readFileSync(policyPath, "utf8"))).toEqual(original);
      const applied = run(["--apply"]);
      const backup = applied.match(/Policy backup and proposed update: (.+)/);
      expect(backup).not.toBeNull();
      expect(
        JSON.parse(readFileSync(join(backup![1], "original.json"), "utf8")),
      ).toEqual(original);
      const updated = JSON.parse(readFileSync(policyPath, "utf8"));
      expect(updated.Statement[0]).toEqual(original.Statement[0]);
      expect(updated.Statement[1].NotAction).toEqual(
        original.Statement[1].NotAction,
      );
      expect(
        updated.Statement[1].Condition.StringNotEquals["aws:RequestedRegion"],
      ).toEqual([
        "eu-north-1",
        "unspecified",
        "us-east-1",
        "us-west-2",
        "eu-west-1",
        "eu-central-1",
        "eu-west-2",
        "eu-west-3",
      ]);
      expect(run(["--apply"])).toContain("no update is needed");
      expect(() =>
        run(["--apply"], { TEST_ACCOUNT: "123456789012" }),
      ).toThrow();
      expect(() => run(["--apply", "invalid-region"])).toThrow();
      expect(() =>
        run(["--apply", "eu-south-1"], { TEST_DENY: "true" }),
      ).toThrow();
      expect(JSON.parse(readFileSync(policyPath, "utf8"))).toEqual(updated);

      writeFileSync(policyPath, JSON.stringify({ ...original, Statement: [] }));
      expect(() => run(["--apply"])).toThrow();
      expect(JSON.parse(readFileSync(policyPath, "utf8")).Statement).toEqual(
        [],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
