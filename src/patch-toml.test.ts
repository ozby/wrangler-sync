import { describe, it, expect } from "vitest";
import { patchEnvBinding } from "./patch-toml.js";

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

describe("patchEnvBinding", () => {
  it("patches a hyperdrive ID inside [[env.dev.hyperdrive]]", () => {
    const result = patchEnvBinding(
      SAMPLE_TOML,
      "[[env.dev.hyperdrive]]",
      "id",
      "new-hyperdrive-id",
    );
    expect(result).toContain('id = "new-hyperdrive-id"');
    // Staging block must be untouched
    expect(result).toContain('id = "staging-hyperdrive-id"');
    // Old value gone from dev block
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
    const result = patchEnvBinding(toml, "[[env.dev.r2_buckets]]", "bucket_name", "new-bucket");
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
