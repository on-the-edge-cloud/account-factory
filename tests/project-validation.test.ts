import { describe, expect, it } from "vitest";
import { detectPackageManager } from "../src/services/project-validation.js";

describe("existing project package-manager detection", () => {
  it("detects managers from the repository lockfile", () => {
    expect(
      detectPackageManager(
        '{"dependencies":{"next":"15"}}',
        new Set(["package.json", "yarn.lock"]),
      ),
    ).toBe("yarn");
    expect(
      detectPackageManager(
        '{"dependencies":{"next":"15"}}',
        new Set(["package.json", "package-lock.json"]),
      ),
    ).toBe("npm");
    expect(
      detectPackageManager(
        '{"dependencies":{"next":"15"}}',
        new Set(["package.json", "pnpm-lock.yaml"]),
      ),
    ).toBe("pnpm");
  });

  it("uses packageManager when a lockfile is absent", () => {
    expect(
      detectPackageManager(
        '{"packageManager":"pnpm@9.0.0","dependencies":{"next":"15"}}',
        new Set(["package.json"]),
      ),
    ).toBe("pnpm");
  });

  it("selects npm install rather than npm ci when an existing repo has no lockfile", () => {
    const manager = detectPackageManager(
      '{"packageManager":"npm@10.0.0","dependencies":{"next":"15"}}',
      new Set(["package.json"]),
    );
    expect(manager).toBe("npm");
  });

  it("rejects conflicting managers and non-Next repositories", () => {
    expect(() =>
      detectPackageManager(
        '{"dependencies":{"next":"15"}}',
        new Set(["yarn.lock", "package-lock.json"]),
      ),
    ).toThrow(/multiple package-manager/);
    expect(() =>
      detectPackageManager(
        '{"packageManager":"npm@10","dependencies":{"next":"15"}}',
        new Set(["yarn.lock"]),
      ),
    ).toThrow(/declares npm/);
    expect(() =>
      detectPackageManager(
        '{"packageManager":"npm@10"}',
        new Set(["package-lock.json"]),
      ),
    ).toThrow(/not a Next.js/);
  });
});
