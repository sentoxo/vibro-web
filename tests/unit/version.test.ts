import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const atRoot = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

describe("app version", () => {
  const version = atRoot("VERSION").trim();
  const pkg = JSON.parse(atRoot("package.json")) as { version: string };

  it("VERSION is the single source and package.json mirrors it", () => {
    // vite.config.ts injects VERSION as __APP_VERSION__; package.json is npm
    // metadata. Drift would make the status strip and `npm view .` disagree.
    expect(version).toBe(pkg.version);
  });

  it("is a release (x.y.z) or dev (x.y.z-dev) version", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+(-dev)?$/);
  });

  it("the VERSION file is one trimmed line, so vite injects no whitespace", () => {
    expect(atRoot("VERSION")).toBe(`${version}\n`);
  });
});
