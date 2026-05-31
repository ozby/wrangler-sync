import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildPreviewCleanupPlan,
  derivePreviewHostname,
  syncWranglerBindings,
} from "./index.js";

const FIXTURE_TOML = `
[env.dev]
name = "my-worker-dev"

[[env.dev.hyperdrive]]
binding = "DB"
id = "old-hyperdrive-id"

[[env.dev.kv_namespaces]]
binding = "KV"
id = "old-kv-id"

[[env.dev.r2_buckets]]
binding = "BUCKET"
bucket_name = "old-bucket"

[[env.dev.queues.producers]]
queue = "new-queue"
binding = "QUEUE"
`;

let tmpDir: string;
let tomlPath: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `wrangler-sync-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  tomlPath = join(tmpDir, "wrangler.toml");
  writeFileSync(tomlPath, FIXTURE_TOML);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const stackOutputs = {
  hyperdriveId: "new-hyperdrive-id",
  kvNamespaceId: "new-kv-id",
  r2BucketName: "new-bucket",
  deliveryQueueName: "new-queue",
};

describe("syncWranglerBindings", () => {
  it("dryRun returns patches without writing to disk", () => {
    const result = syncWranglerBindings({
      stackName: "dev",
      wranglerTomlPath: tomlPath,
      mappings: [
        { pulumiOutput: "hyperdriveId", header: "[[env.dev.hyperdrive]]", key: "id" },
      ],
      stackOutputs,
      dryRun: true,
    });

    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0]).toMatchObject({
      header: "[[env.dev.hyperdrive]]",
      key: "id",
      oldValue: "old-hyperdrive-id",
      newValue: "new-hyperdrive-id",
    });

    // Disk must be untouched
    const onDisk = readFileSync(tomlPath, "utf8");
    expect(onDisk).toContain("old-hyperdrive-id");
  });

  it("writes correct patched TOML to disk", () => {
    const result = syncWranglerBindings({
      stackName: "dev",
      wranglerTomlPath: tomlPath,
      mappings: [
        { pulumiOutput: "hyperdriveId", header: "[[env.dev.hyperdrive]]", key: "id" },
        { pulumiOutput: "kvNamespaceId", header: "[[env.dev.kv_namespaces]]", key: "id" },
        { pulumiOutput: "r2BucketName", header: "[[env.dev.r2_buckets]]", key: "bucket_name" },
      ],
      stackOutputs,
    });

    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(3);

    const written = readFileSync(tomlPath, "utf8");
    expect(written).toContain('id = "new-hyperdrive-id"');
    expect(written).toContain('id = "new-kv-id"');
    expect(written).toContain('bucket_name = "new-bucket"');
    expect(written).not.toContain("old-hyperdrive-id");
    expect(written).not.toContain("old-kv-id");
    expect(written).not.toContain("old-bucket");
  });

  it("reports changed=false when values are already current", () => {
    // Pre-patch to match what stackOutputs says
    const alreadyCurrent = FIXTURE_TOML.replace("old-hyperdrive-id", "new-hyperdrive-id");
    writeFileSync(tomlPath, alreadyCurrent);

    const result = syncWranglerBindings({
      stackName: "dev",
      wranglerTomlPath: tomlPath,
      mappings: [
        { pulumiOutput: "hyperdriveId", header: "[[env.dev.hyperdrive]]", key: "id" },
      ],
      stackOutputs,
    });

    expect(result.changed).toBe(false);
  });

  it("verify entries that match pass", () => {
    const result = syncWranglerBindings({
      stackName: "dev",
      wranglerTomlPath: tomlPath,
      mappings: [
        { pulumiOutput: "hyperdriveId", header: "[[env.dev.hyperdrive]]", key: "id" },
      ],
      verify: [
        { pulumiOutput: "deliveryQueueName", pattern: 'queue = "{value}"' },
      ],
      stackOutputs,
    });

    expect(result.verified).toHaveLength(1);
    expect(result.verified[0]).toMatchObject({
      pulumiOutput: "deliveryQueueName",
      pattern: 'queue = "{value}"',
      found: true,
    });
  });

  it("throws when a verify entry does not match", () => {
    expect(() =>
      syncWranglerBindings({
        stackName: "dev",
        wranglerTomlPath: tomlPath,
        mappings: [],
        verify: [
          // "missing-queue" is not in the fixture toml
          { pulumiOutput: "deliveryQueueName", pattern: 'queue = "{value}"' },
        ],
        stackOutputs: { ...stackOutputs, deliveryQueueName: "missing-queue" },
      }),
    ).toThrow("Verification failed");
  });

  it("throws when a mapping references a missing Pulumi output", () => {
    expect(() =>
      syncWranglerBindings({
        stackName: "dev",
        wranglerTomlPath: tomlPath,
        mappings: [
          { pulumiOutput: "doesNotExist", header: "[[env.dev.hyperdrive]]", key: "id" },
        ],
        stackOutputs,
      }),
    ).toThrow('Pulumi output "doesNotExist" not found');
  });
});

describe("derivePreviewHostname", () => {
  it("derives hostnames from internal lane IDs using dash-safe env names", () => {
    expect(derivePreviewHostname("dev", "example.com")).toBe("dev.example.com");
    expect(derivePreviewHostname("preview_main", "example.com")).toBe(
      "preview-main.example.com",
    );
    expect(derivePreviewHostname("preview_pr_42", "example.com")).toBe(
      "preview-pr-42.example.com",
    );
  });
});

describe("buildPreviewCleanupPlan", () => {
  it("renders a wrangler delete command for preview lanes", () => {
    expect(buildPreviewCleanupPlan("preview_main")).toEqual({
      wranglerEnvName: "preview-main",
      deleteCommand: "wrangler delete --env preview-main",
      repoCleanupHook: undefined,
    });
  });

  it("preserves the explicit production env-name mapping", () => {
    expect(buildPreviewCleanupPlan("prd", "pnpm run cleanup:preview")).toEqual({
      wranglerEnvName: "production",
      deleteCommand: "wrangler delete --env production",
      repoCleanupHook: "pnpm run cleanup:preview",
    });
  });
});
