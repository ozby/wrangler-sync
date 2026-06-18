import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  syncJsoncBindings,
  upsertEnvCustomDomainRoute,
  upsertEnvDurableObjectBinding,
} from "./patch-jsonc.js";

// Minimal wrangler.jsonc fixture — realistic structure with comments and placeholders.
const PLATFORM_API_FIXTURE = `{
  "name": "platform-api",
  "env": {
    // Preview environment
    "preview": {
      "name": "webpresso-api-alpha",
      "hyperdrive": [
        {
          "binding": "HYPERDRIVE",
          "id": "placeholder-hd-preview", // Overridden by CLI deploy
          "localConnectionString": "postgresql://x"
        }
      ],
      "r2_buckets": [
        {
          "binding": "GIT_STORAGE",
          "bucket_name": "git-storage-preview-placeholder", // Overridden by CLI deploy
          "jurisdiction": "eu"
        }
      ],
      "kv_namespaces": [
        { "binding": "WORKER_METADATA", "id": "worker-metadata-preview-placeholder" },
        { "binding": "STATUS_PAGE_KV", "id": "status-page-kv-preview-placeholder" }
      ]
    },
    "production": {
      "name": "platform-prod",
      "hyperdrive": [
        {
          "binding": "HYPERDRIVE",
          "id": "placeholder-hd-production", // Overridden by CLI deploy
          "localConnectionString": "postgresql://x"
        }
      ],
      "r2_buckets": [
        {
          "binding": "GIT_STORAGE",
          "bucket_name": "git-storage-production-placeholder", // Overridden by CLI deploy
          "jurisdiction": "eu"
        }
      ],
      "kv_namespaces": [
        { "binding": "WORKER_METADATA", "id": "worker-metadata-production-placeholder" },
        { "binding": "STATUS_PAGE_KV", "id": "status-page-kv-production-placeholder" }
      ]
    }
  }
}
`;

const DISPATCH_FIXTURE = `{
  "name": "webpresso-dispatch",
  "kv_namespaces": [
    { "binding": "WORKER_METADATA", "id": "WORKER_METADATA_KV_ID" }
  ],
  "env": {
    "production": {
      "dispatch_namespaces": [
        { "binding": "DISPATCHER", "namespace": "dispatch-prd" }
      ],
      "kv_namespaces": [
        { "binding": "WORKER_METADATA", "id": "WORKER_METADATA_KV_ID" }
      ]
    },
    "preview": {
      "dispatch_namespaces": [
        { "binding": "DISPATCHER", "namespace": "dispatch-preview" }
      ],
      "kv_namespaces": [
        { "binding": "WORKER_METADATA", "id": "WORKER_METADATA_KV_ID" }
      ]
    }
  }
}
`;

const PREVIEW_CONTRACT_FIXTURE = `{
  "name": "preview-contract-worker",
  "env": {
    "preview-pr-123": {
      "name": "preview-contract-pr-123"
    },
    "preview-main": {
      "name": "preview-contract-main",
      "routes": [
        {
          "pattern": "old-preview-main.example.com",
          "custom_domain": true
        }
      ],
      "durable_objects": {
        "bindings": [
          {
            "name": "PREVIEW_COORDINATOR",
            "class_name": "OldPreviewCoordinator"
          }
        ]
      }
    },
    "production": {
      "name": "preview-contract-production",
      "routes": [
        {
          "pattern": "prod.example.com",
          "custom_domain": true
        }
      ]
    }
  }
}
`;

function writeTmpJsonc(fixture: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wrangler-sync-test-"));
  const filePath = path.join(dir, "wrangler.jsonc");
  writeFileSync(filePath, fixture, "utf-8");
  return filePath;
}

function sectionFrom(
  content: string,
  startMarker: string,
  endMarker?: string,
): string {
  const start = content.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);

  if (!endMarker) {
    return content.slice(start);
  }

  const end = content.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return content.slice(start, end);
}

describe("syncJsoncBindings", () => {
  it("patches hyperdrive id in preview env", () => {
    const wranglerPath = writeTmpJsonc(PLATFORM_API_FIXTURE);

    const result = syncJsoncBindings({
      wranglerPath,
      env: "preview",
      patches: [{ bindingName: "HYPERDRIVE", key: "id", value: "real-hd-id-abc" }],
    });

    expect(result.changed).toBe(true);
    expect(result.applied[0]?.oldValue).toBe("placeholder-hd-preview");
    expect(result.applied[0]?.newValue).toBe("real-hd-id-abc");

    const written = readFileSync(wranglerPath, "utf-8");
    expect(written).toContain('"id": "real-hd-id-abc"');
    // Production placeholder must remain untouched
    expect(written).toContain('"id": "placeholder-hd-production"');
  });

  it("patches bucket_name in production env", () => {
    const wranglerPath = writeTmpJsonc(PLATFORM_API_FIXTURE);

    syncJsoncBindings({
      wranglerPath,
      env: "production",
      patches: [
        { bindingName: "GIT_STORAGE", key: "bucket_name", value: "real-bucket-prod" },
      ],
    });

    const written = readFileSync(wranglerPath, "utf-8");
    expect(written).toContain('"bucket_name": "real-bucket-prod"');
    // Preview placeholder must remain untouched
    expect(written).toContain('"bucket_name": "git-storage-preview-placeholder"');
  });

  it("patches multiple bindings in one call", () => {
    const wranglerPath = writeTmpJsonc(PLATFORM_API_FIXTURE);

    syncJsoncBindings({
      wranglerPath,
      env: "preview",
      patches: [
        { bindingName: "HYPERDRIVE", key: "id", value: "hd-real" },
        { bindingName: "WORKER_METADATA", key: "id", value: "kv-real" },
        { bindingName: "STATUS_PAGE_KV", key: "id", value: "sp-real" },
        { bindingName: "GIT_STORAGE", key: "bucket_name", value: "r2-real" },
      ],
    });

    const written = readFileSync(wranglerPath, "utf-8");
    expect(written).toContain('"id": "hd-real"');
    expect(written).toContain('"id": "kv-real"');
    expect(written).toContain('"id": "sp-real"');
    expect(written).toContain('"bucket_name": "r2-real"');
  });

  it("dryRun does not write the file", () => {
    const wranglerPath = writeTmpJsonc(PLATFORM_API_FIXTURE);
    const originalContent = readFileSync(wranglerPath, "utf-8");

    const result = syncJsoncBindings({
      wranglerPath,
      env: "preview",
      patches: [{ bindingName: "HYPERDRIVE", key: "id", value: "hd-dry-run" }],
      dryRun: true,
    });

    expect(result.changed).toBe(true);
    const afterContent = readFileSync(wranglerPath, "utf-8");
    expect(afterContent).toBe(originalContent);
  });

  it("returns changed=false when value is already current", () => {
    const wranglerPath = writeTmpJsonc(PLATFORM_API_FIXTURE);

    const result = syncJsoncBindings({
      wranglerPath,
      env: "preview",
      patches: [
        { bindingName: "HYPERDRIVE", key: "id", value: "placeholder-hd-preview" },
      ],
    });

    expect(result.changed).toBe(false);
  });

  it("patches WORKER_METADATA KV in dispatch preview env", () => {
    const wranglerPath = writeTmpJsonc(DISPATCH_FIXTURE);

    syncJsoncBindings({
      wranglerPath,
      env: "preview",
      patches: [
        { bindingName: "WORKER_METADATA", key: "id", value: "real-kv-id-preview" },
      ],
    });

    const written = readFileSync(wranglerPath, "utf-8");
    // Preview env must be patched
    expect(written).toContain('"id": "real-kv-id-preview"');
    // Production env must remain untouched
    const productionSection = written.slice(written.indexOf('"production"'));
    expect(productionSection).toContain('"id": "WORKER_METADATA_KV_ID"');
  });

  it("patches dispatch namespace in preview env", () => {
    const wranglerPath = writeTmpJsonc(DISPATCH_FIXTURE);

    syncJsoncBindings({
      wranglerPath,
      env: "preview",
      patches: [
        {
          bindingName: "DISPATCHER",
          key: "namespace",
          value: "dispatch-preview-real",
        },
      ],
    });

    const written = readFileSync(wranglerPath, "utf-8");
    // Verify the patched value appears in the file
    expect(written).toContain('"namespace": "dispatch-preview-real"');
    // Verify production namespace is untouched (uses "dispatch-prd" not "dispatch-preview")
    expect(written).toContain('"namespace": "dispatch-prd"');
    // The original "dispatch-preview" value must have been replaced
    expect(written).not.toContain('"namespace": "dispatch-preview"');
  });

  it("throws when env block is missing", () => {
    const wranglerPath = writeTmpJsonc(PLATFORM_API_FIXTURE);

    expect(() =>
      syncJsoncBindings({
        wranglerPath,
        env: "staging",
        patches: [{ bindingName: "HYPERDRIVE", key: "id", value: "x" }],
      }),
    ).toThrow("env.staging");
  });

  it("throws when binding is missing in env", () => {
    const wranglerPath = writeTmpJsonc(PLATFORM_API_FIXTURE);

    expect(() =>
      syncJsoncBindings({
        wranglerPath,
        env: "preview",
        patches: [{ bindingName: "NONEXISTENT_BINDING", key: "id", value: "x" }],
      }),
    ).toThrow("NONEXISTENT_BINDING");
  });

  it("preserves comments after patching", () => {
    const wranglerPath = writeTmpJsonc(PLATFORM_API_FIXTURE);

    syncJsoncBindings({
      wranglerPath,
      env: "preview",
      patches: [{ bindingName: "HYPERDRIVE", key: "id", value: "hd-new" }],
    });

    const written = readFileSync(wranglerPath, "utf-8");
    expect(written).toContain("// Preview environment");
    expect(written).toContain("// Overridden by CLI deploy");
  });
});

describe("env-specific JSONC preview helpers", () => {
  it("renders a custom-domain route inside a dash-safe env block when routes are missing", () => {
    const rendered = upsertEnvCustomDomainRoute(PREVIEW_CONTRACT_FIXTURE, "preview-pr-123", {
      pattern: "preview-pr-123.edge-matte.ozby.dev",
    });

    const previewPrSection = sectionFrom(rendered, '"preview-pr-123"', '"preview-main"');
    expect(previewPrSection).toContain('"routes": [');
    expect(previewPrSection).toContain('"pattern": "preview-pr-123.edge-matte.ozby.dev"');
    expect(previewPrSection).toContain('"custom_domain": true');

    const productionSection = sectionFrom(rendered, '"production"');
    expect(productionSection).toContain('"pattern": "prod.example.com"');
  });

  it("patches the env-specific custom-domain route without touching sibling envs", () => {
    const rendered = upsertEnvCustomDomainRoute(PREVIEW_CONTRACT_FIXTURE, "preview-main", {
      pattern: "preview-main.edge-matte.ozby.dev",
    });

    const previewMainSection = sectionFrom(rendered, '"preview-main"', '"production"');
    expect(previewMainSection).toContain('"pattern": "preview-main.edge-matte.ozby.dev"');
    expect(previewMainSection).not.toContain('"pattern": "old-preview-main.example.com"');

    const productionSection = sectionFrom(rendered, '"production"');
    expect(productionSection).toContain('"pattern": "prod.example.com"');
  });

  it("renders a Durable Object binding inside a dash-safe env block when durable_objects is missing", () => {
    const rendered = upsertEnvDurableObjectBinding(
      PREVIEW_CONTRACT_FIXTURE,
      "preview-pr-123",
      {
        name: "PREVIEW_COORDINATOR",
        className: "PreviewCoordinator",
        scriptName: "edge-matte-preview-pr-123",
      },
    );

    const previewPrSection = sectionFrom(rendered, '"preview-pr-123"', '"preview-main"');
    expect(previewPrSection).toContain('"durable_objects": {');
    expect(previewPrSection).toContain('"bindings": [');
    expect(previewPrSection).toContain('"name": "PREVIEW_COORDINATOR"');
    expect(previewPrSection).toContain('"class_name": "PreviewCoordinator"');
    expect(previewPrSection).toContain('"script_name": "edge-matte-preview-pr-123"');
  });

  it("patches an env-specific Durable Object binding inside existing bindings", () => {
    const rendered = upsertEnvDurableObjectBinding(
      PREVIEW_CONTRACT_FIXTURE,
      "preview-main",
      {
        name: "PREVIEW_COORDINATOR",
        className: "PreviewCoordinator",
        scriptName: "edge-matte-preview-main",
      },
    );

    const previewMainSection = sectionFrom(rendered, '"preview-main"', '"production"');
    expect(previewMainSection).toContain('"name": "PREVIEW_COORDINATOR"');
    expect(previewMainSection).toContain('"class_name": "PreviewCoordinator"');
    expect(previewMainSection).toContain('"script_name": "edge-matte-preview-main"');
    expect(previewMainSection).not.toContain('"class_name": "OldPreviewCoordinator"');

    const productionSection = sectionFrom(rendered, '"production"');
    expect(productionSection).toContain('"pattern": "prod.example.com"');
  });
});
