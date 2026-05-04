# @ozby/wrangler-sync

Sync Pulumi stack outputs into `wrangler.toml` / `wrangler.jsonc` binding IDs in-place.

When you provision Cloudflare Workers infrastructure with Pulumi — Hyperdrive, KV
namespaces, R2 buckets, Queues — Pulumi outputs the resource IDs. Your wrangler
config needs those IDs to deploy. There is no built-in bridge between the two tools.

This package reads `pulumi stack output --json`, finds the matching binding blocks
in your existing wrangler file, and updates the IDs in-place. Everything else —
comments, ordering, other env blocks — is left untouched.

## Install

```sh
pnpm add @ozby/wrangler-sync
```

Add to `.npmrc`:
```
@ozby:registry=https://npm.pkg.github.com
```

## TOML — `syncWranglerBindings`

```ts
import { syncWranglerBindings } from '@ozby/wrangler-sync'

syncWranglerBindings({
  stackName: 'dev',
  wranglerTomlPath: '../apps/workers/wrangler.toml',
  mappings: [
    { pulumiOutput: 'hyperdriveId',  header: '[[env.dev.hyperdrive]]',    key: 'id' },
    { pulumiOutput: 'kvNamespaceId', header: '[[env.dev.kv_namespaces]]', key: 'id' },
    { pulumiOutput: 'r2BucketName',  header: '[[env.dev.r2_buckets]]',    key: 'bucket_name' },
  ],
  // verify: values that must exist verbatim in the file after sync
  verify: [
    { pulumiOutput: 'deliveryQueueName', pattern: 'queue = "{value}"' },
  ],
})
```

Options:
- `stackOutputs` — skip the real `pulumi` CLI (inject outputs directly; useful in tests)
- `dryRun` — return what would change without writing

## JSONC — `syncJsoncBindings`

Token-aware patcher for `wrangler.jsonc`. Preserves comments and formatting.

```ts
import { syncJsoncBindings } from '@ozby/wrangler-sync'

syncJsoncBindings({
  wranglerPath: 'apps/api/wrangler.jsonc',
  env: 'preview',
  patches: [
    { bindingName: 'HYPERDRIVE', key: 'id',          value: 'abc123' },
    { bindingName: 'KV',         key: 'id',          value: 'def456' },
    { bindingName: 'BUCKET',     key: 'bucket_name', value: 'my-bucket' },
  ],
})
```

## CLI

```sh
npx @ozby/wrangler-sync <stack> <wrangler.toml> <mappings.json>
```
