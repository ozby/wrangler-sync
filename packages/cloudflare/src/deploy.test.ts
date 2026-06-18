import { describe, expect, it } from "vitest";

import {
  createCloudflareDeployAdapter,
  createPreviewWranglerConfig,
  resolveCloudflarePreviewLane,
} from "./deploy.js";

describe("Cloudflare deploy helpers", () => {
  it("resolves canonical preview lanes to dashed hostnames and worker names", () => {
    expect(resolveCloudflarePreviewLane({ domain: "example.com", workerName: "example-worker" }, "preview_main")).toEqual({
      lane: "preview-main",
      hostname: "preview-main.example.com",
      workerName: "example-worker-preview-main",
      url: "https://preview-main.example.com",
    });
  });

  it("creates preview and production deploy plans", () => {
    const adapter = createCloudflareDeployAdapter({
      repoRoot: "/repo",
      productionScriptPath: "/repo/infra/src/deploy/deploy-production.ts",
      previewScriptPath: "/repo/infra/src/deploy/deploy-preview.ts",
      app: { domain: "example.com", workerName: "example-worker" },
    });

    expect(adapter.createPlan({ lane: "preview_main", dryRun: true }).steps[0]?.args).toEqual([
      "/repo/infra/src/deploy/deploy-preview.ts",
      "--lane",
      "preview-main",
      "--dry-run",
    ]);
    expect(adapter.createPlan({ lane: "prd", dryRun: false, releaseVersion: "1.2.3" })).toMatchObject({
      provider: "cloudflare",
      requiredCredentials: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ZONE_ID"],
      releaseVersion: "1.2.3",
    });
  });

  it("rejects relative deploy script paths", () => {
    expect(() => createCloudflareDeployAdapter({
      repoRoot: "/repo",
      productionScriptPath: "infra/src/deploy/deploy-production.ts",
      previewScriptPath: "/repo/infra/src/deploy/deploy-preview.ts",
      app: { domain: "example.com", workerName: "example-worker" },
    })).toThrow("absolute");
  });

  it("generates preview wrangler config with sender-restricted email binding", () => {
    const config = createPreviewWranglerConfig({
      baseConfig: {
        $schema: "schema",
        main: "src/index.ts",
        compatibility_date: "2026-06-18",
        assets: { directory: "../client/dist", binding: "ASSETS" },
      },
      lane: { lane: "preview-main", hostname: "preview-main.example.com", workerName: "example-worker-preview-main", url: "https://preview-main.example.com" },
      emailFrom: "info@example.com",
    });

    expect(config).toMatchObject({
      name: "example-worker-preview-main",
      routes: [{ pattern: "preview-main.example.com", custom_domain: true }],
      send_email: [{ name: "EMAIL", allowed_sender_addresses: ["info@example.com"] }],
    });
  });
});
