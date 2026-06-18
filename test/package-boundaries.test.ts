import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;
}

describe("package boundaries", () => {
  it("uses a private cloudflare workspace root with packages/* workspaces", () => {
    const pkg = json("package.json");
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");

    expect(pkg).toMatchObject({ name: "cloudflare", private: true });
    expect(workspace).toContain("packages/*");
  });

  it("keeps wrangler-sync as its own package without contact/deploy exports", () => {
    const pkg = json("packages/wrangler-sync/package.json");

    expect(pkg).toMatchObject({ name: "@ozby/wrangler-sync" });
    expect(pkg.bin).toEqual({ "wrangler-sync": "dist/bin/wrangler-sync.js" });
    expect(Object.keys(pkg.exports as Record<string, unknown>)).toEqual(["."]);
  });

  it("publishes Cloudflare helpers from the properly named cloudflare package", () => {
    const pkg = json("packages/cloudflare/package.json");

    expect(pkg).toMatchObject({ name: "@ozby/cloudflare" });
    expect(Object.keys(pkg.exports as Record<string, unknown>)).toEqual([".", "./contact-form", "./deploy"]);
  });

  it("records the new Cloudflare helper release on @ozby/cloudflare", () => {
    const changesetPath = join(root, ".changeset/cloudflare-contact-deploy.md");

    if (existsSync(changesetPath)) {
      const changeset = readFileSync(changesetPath, "utf8");
      expect(changeset).toContain('"@ozby/cloudflare": minor');
      expect(changeset).not.toContain('"@ozby/wrangler-sync": minor');
      return;
    }

    const pkg = json("packages/cloudflare/package.json");
    const changelog = readFileSync(join(root, "packages/cloudflare/CHANGELOG.md"), "utf8");

    expect(pkg.version).toBe("0.1.0");
    expect(changelog).toContain("## 0.1.0");
    expect(changelog).toContain("Cloudflare Worker contact form helpers");
  });

  it("does not publish local link, file, or parent-relative package surfaces", () => {
    const packageSurfaceFiles = [
      "package.json",
      "README.md",
      "packages/wrangler-sync/package.json",
      "packages/wrangler-sync/README.md",
      "packages/wrangler-sync/tsconfig.json",
      "packages/cloudflare/package.json",
      "packages/cloudflare/README.md",
      "packages/cloudflare/tsconfig.json",
    ];

    for (const file of packageSurfaceFiles) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text, file).not.toContain("link:");
      expect(text, file).not.toContain("file:");
      expect(text, file).not.toContain("../");
    }
  });
});
