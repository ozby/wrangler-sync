import { describe, expect, it } from "vitest";

import {
  patchEnvBinding,
  renderEnvDurableObjectBinding,
  renderEnvCustomDomainRoute,
  upsertEnvDurableObjectBinding,
  upsertEnvCustomDomainRoute,
  wranglerEnvName,
} from "./patch-toml.js";

const SAMPLE_TOML = `
[env.dev]
name = "my-worker-dev"

[[env.dev.hyperdrive]]
binding = "DB"
id = "old-hyperdrive-id"

[[env.dev.kv_namespaces]]
binding = "KV"
id = "old-kv-id"

[env.staging]
name = "my-worker-staging"

[[env.staging.hyperdrive]]
binding = "DB"
id = "staging-hyperdrive-id"
`;

const INLINE_ROUTE_TOML = `
[env.dev]
name = "my-worker-dev"
routes = [{ pattern = "old.dev.example.com", custom_domain = true }]

[env.dev.vars]
APP_ORIGIN = "https://old.dev.example.com"

[env.production]
name = "my-worker"
routes = [{ pattern = "app.example.com", custom_domain = true }]
`;

const TABLE_ROUTE_TOML = `
[env.production]
name = "my-worker"
workers_dev = false

[[env.production.routes]]
pattern = "old.example.com"
custom_domain = true

[env.production.vars]
APP_ORIGIN = "https://old.example.com"
`;

const DASHED_ENV_TOML = `
[env.preview-pr-42]
name = "my-worker-preview-pr-42"
workers_dev = false

[env.preview-pr-42.vars]
APP_ORIGIN = "https://preview-pr-42.example.com"
`;

describe("wranglerEnvName", () => {
  it("derives dash-safe Wrangler env names from internal lane IDs", () => {
    expect(wranglerEnvName("dev")).toBe("dev");
    expect(wranglerEnvName("preview_main")).toBe("preview-main");
    expect(wranglerEnvName("preview_pr_42")).toBe("preview-pr-42");
    expect(wranglerEnvName("prd")).toBe("production");
  });

  it("throws for unsupported lane IDs", () => {
    expect(() => wranglerEnvName("preview")).toThrow('Unsupported lane ID "preview"');
    expect(() => wranglerEnvName("preview_pr_abc")).toThrow(
      'Unsupported lane ID "preview_pr_abc"',
    );
  });
});

describe("renderEnvCustomDomainRoute", () => {
  it("renders an env-specific custom-domain route block", () => {
    expect(
      renderEnvCustomDomainRoute("preview-pr-42", "pr-42.edge-matte.ozby.dev"),
    ).toBe(
      [
        "[[env.preview-pr-42.routes]]",
        'pattern = "pr-42.edge-matte.ozby.dev"',
        "custom_domain = true",
      ].join("\n"),
    );
  });
});

describe("env-specific Durable Object TOML helpers", () => {
  it("renders an env-specific Durable Object binding block", () => {
    expect(
      renderEnvDurableObjectBinding("preview-pr-42", {
        name: "PREVIEW_COORDINATOR",
        className: "PreviewCoordinator",
        scriptName: "edge-matte-preview-pr-42",
      }),
    ).toBe(
      [
        "[[env.preview-pr-42.durable_objects.bindings]]",
        'name = "PREVIEW_COORDINATOR"',
        'class_name = "PreviewCoordinator"',
        'script_name = "edge-matte-preview-pr-42"',
      ].join("\n"),
    );
  });

  it("inserts a Durable Object binding for a dashed preview env without touching sibling envs", () => {
    const result = upsertEnvDurableObjectBinding(DASHED_ENV_TOML, "preview-pr-42", {
      name: "PREVIEW_COORDINATOR",
      className: "PreviewCoordinator",
      scriptName: "edge-matte-preview-pr-42",
    });

    const doHeaderIndex = result.indexOf("[[env.preview-pr-42.durable_objects.bindings]]");
    const varsHeaderIndex = result.indexOf("[env.preview-pr-42.vars]");
    expect(doHeaderIndex).toBeGreaterThan(result.indexOf("[env.preview-pr-42]"));
    expect(varsHeaderIndex).toBeGreaterThan(doHeaderIndex);
    expect(result).toContain('name = "PREVIEW_COORDINATOR"');
    expect(result).toContain('class_name = "PreviewCoordinator"');
    expect(result).toContain('script_name = "edge-matte-preview-pr-42"');
  });
});

describe("upsertEnvCustomDomainRoute", () => {
  it("patches inline env routes without touching other envs", () => {
    const result = upsertEnvCustomDomainRoute(
      INLINE_ROUTE_TOML,
      wranglerEnvName("dev"),
      "dev.edge-matte.ozby.dev",
    );

    expect(result).toContain(
      'routes = [{ pattern = "dev.edge-matte.ozby.dev", custom_domain = true }]',
    );
    expect(result).toContain(
      'routes = [{ pattern = "app.example.com", custom_domain = true }]',
    );
    expect(result).not.toContain(
      'routes = [{ pattern = "old.dev.example.com", custom_domain = true }]',
    );
  });

  it("patches array-of-tables production routes while preserving production env naming", () => {
    const result = upsertEnvCustomDomainRoute(
      TABLE_ROUTE_TOML,
      wranglerEnvName("prd"),
      "edge-matte.ozby.dev",
    );

    expect(result).toContain("[[env.production.routes]]");
    expect(result).toContain('pattern = "edge-matte.ozby.dev"');
    expect(result).not.toContain('pattern = "old.example.com"');
  });

  it("inserts a route block for dashed preview env names when none exists", () => {
    const result = upsertEnvCustomDomainRoute(
      DASHED_ENV_TOML,
      wranglerEnvName("preview_pr_42"),
      "pr-42.edge-matte.ozby.dev",
    );

    const envHeaderIndex = result.indexOf("[env.preview-pr-42]");
    const routeHeaderIndex = result.indexOf("[[env.preview-pr-42.routes]]");
    const varsHeaderIndex = result.indexOf("[env.preview-pr-42.vars]");

    expect(routeHeaderIndex).toBeGreaterThan(envHeaderIndex);
    expect(varsHeaderIndex).toBeGreaterThan(routeHeaderIndex);
    expect(result).toContain('pattern = "pr-42.edge-matte.ozby.dev"');
    expect(result).toContain("custom_domain = true");
  });

  it("throws when the env block is missing", () => {
    expect(() =>
      upsertEnvCustomDomainRoute(
        DASHED_ENV_TOML,
        "preview-main",
        "preview-main.edge-matte.ozby.dev",
      ),
    ).toThrow("wrangler.toml missing [env.preview-main]");
  });
});

describe("patchEnvBinding", () => {
  it("patches a hyperdrive ID inside [[env.dev.hyperdrive]]", () => {
    const result = patchEnvBinding(
      SAMPLE_TOML,
      "[[env.dev.hyperdrive]]",
      "id",
      "new-hyperdrive-id",
    );
    expect(result).toContain('id = "new-hyperdrive-id"');
    expect(result).toContain('id = "staging-hyperdrive-id"');
    const devBlockStart = result.indexOf("[[env.dev.hyperdrive]]");
    const devBlockEnd = result.indexOf("\n[", devBlockStart + 1);
    const devBlock = result.slice(devBlockStart, devBlockEnd === -1 ? undefined : devBlockEnd);
    expect(devBlock).not.toContain("old-hyperdrive-id");
  });

  it("patches bucket_name key", () => {
    const toml = `
[[env.dev.r2_buckets]]
binding = "BUCKET"
bucket_name = "old-bucket"
`;
    const result = patchEnvBinding(
      toml,
      "[[env.dev.r2_buckets]]",
      "bucket_name",
      "new-bucket",
    );
    expect(result).toContain('bucket_name = "new-bucket"');
    expect(result).not.toContain("old-bucket");
  });

  it("throws when header is not found", () => {
    expect(() =>
      patchEnvBinding(SAMPLE_TOML, "[[env.prod.hyperdrive]]", "id", "x"),
    ).toThrow("wrangler.toml missing [[env.prod.hyperdrive]]");
  });

  it("throws when key is not found in the block", () => {
    expect(() =>
      patchEnvBinding(SAMPLE_TOML, "[[env.dev.hyperdrive]]", "nonexistent_key", "x"),
    ).toThrow('[[env.dev.hyperdrive]] has no "nonexistent_key" line to patch');
  });

  it("is idempotent when called twice with the same value", () => {
    const once = patchEnvBinding(SAMPLE_TOML, "[[env.dev.hyperdrive]]", "id", "fixed-id");
    const twice = patchEnvBinding(once, "[[env.dev.hyperdrive]]", "id", "fixed-id");
    expect(once).toBe(twice);
  });
});
