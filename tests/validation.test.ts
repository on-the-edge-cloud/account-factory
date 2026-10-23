import { describe, expect, it } from "vitest";
import {
  accountEmail,
  isValidDomain,
  validateProjectInput,
} from "../src/validation.js";

const validInput = {
  projectName: "mi-proyecto",
  appType: "static" as const,
  awsRegion: "eu-west-1",
  nodeVersion: "22",
};

describe("project input validation", () => {
  it.each([
    "Upper",
    "two--hyphens",
    "-leading",
    "trailing-",
    "white space",
    "a".repeat(41),
  ])("rejects invalid project name %s", (projectName) =>
    expect(() =>
      validateProjectInput({ ...validInput, projectName }),
    ).toThrow(),
  );

  it("accepts the longest supported project name", () => {
    expect(
      validateProjectInput({ ...validInput, projectName: "a".repeat(40) })
        .projectName,
    ).toHaveLength(40);
  });

  it("generates a unique plus-address root email", () => {
    expect(accountEmail("mi-proyecto")).toBe(
      "fmoreno+mi-proyecto@ontheedge.cloud",
    );
  });

  it.each(["example.com", "sub.example.co.uk"])(
    "accepts hostname %s",
    (customDomain) => {
      expect(isValidDomain(customDomain)).toBe(true);
    },
  );

  it.each([
    "https://example.com",
    "example",
    "-bad.example",
    "bad-.example",
    "example.com/path",
    "example.123",
  ])("rejects invalid hostname %s", (customDomain) =>
    expect(isValidDomain(customDomain)).toBe(false),
  );

  it("rejects a malformed custom domain", () => {
    expect(() =>
      validateProjectInput({
        ...validInput,
        customDomain: "https://example.com",
      }),
    ).toThrow(/custom_domain/);
  });
});
