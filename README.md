# cloudflare

Cloudflare package workspace for Ozby projects.

## Packages

- `@ozby/wrangler-sync` — sync Pulumi stack outputs into Wrangler TOML/JSONC binding IDs and custom-domain routes.
- `@ozby/cloudflare` — Worker-native helpers for contact forms, Cloudflare Email Sending, Turnstile validation, preview Wrangler config, and deploy plans.

## Install from GitHub Packages

Add to `.npmrc`:

```ini
@ozby:registry=https://npm.pkg.github.com
```

Then install only the package you need:

```sh
pnpm add @ozby/cloudflare
pnpm add @ozby/wrangler-sync
```

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run release:check
```

Releases are managed by Changesets from the workspace root.
