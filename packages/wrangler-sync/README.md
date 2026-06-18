# @ozby/wrangler-sync

Sync Pulumi stack outputs into `wrangler.toml` / `wrangler.jsonc` binding IDs in-place.

When you provision Cloudflare Workers infrastructure with Pulumi — Hyperdrive, KV namespaces, R2 buckets, Queues — Pulumi outputs the resource IDs. Your Wrangler config needs those IDs to deploy. This package reads `pulumi stack output --json`, finds matching binding blocks in your existing Wrangler file, and updates IDs in-place while preserving comments, ordering, and unrelated env blocks.

## Install

```sh
pnpm add @ozby/wrangler-sync
```

Add to `.npmrc`:

```ini
@ozby:registry=https://npm.pkg.github.com
```

## TOML — `syncWranglerBindings`

```ts
import { syncWranglerBindings } from '@ozby/wrangler-sync'

const workerWranglerTomlPath = '/workspace/example/apps/workers/wrangler.toml'

syncWranglerBindings({
  stackName: 'dev',
  wranglerTomlPath: workerWranglerTomlPath,
  mappings: [
    { pulumiOutput: 'hyperdriveId',  header: '[[env.dev.hyperdrive]]',    key: 'id' },
    { pulumiOutput: 'kvNamespaceId', header: '[[env.dev.kv_namespaces]]', key: 'id' },
    { pulumiOutput: 'r2BucketName',  header: '[[env.dev.r2_buckets]]',    key: 'bucket_name' },
  ],
  verify: [
    { pulumiOutput: 'deliveryQueueName', pattern: 'queue = "{value}"' },
  ],
})
```

Options:
- `stackOutputs` — skip the real `pulumi` CLI and inject outputs directly
- `dryRun` — return what would change without writing

## JSONC — `syncJsoncBindings`

Token-aware patcher for `wrangler.jsonc`. Preserves comments and formatting.

```ts
import { syncJsoncBindings } from '@ozby/wrangler-sync'

const workerWranglerJsoncPath = '/workspace/example/apps/workers/wrangler.jsonc'

syncJsoncBindings({
  wranglerPath: workerWranglerJsoncPath,
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
npx @ozby/wrangler-sync <stack> /workspace/example/apps/workers/wrangler.toml /workspace/example/infra/mappings.json
```
