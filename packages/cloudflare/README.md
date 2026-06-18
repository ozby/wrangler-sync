# @ozby/cloudflare

Worker-native Cloudflare helpers for contact forms, Cloudflare Email Sending, Turnstile validation, preview Wrangler config generation, and deploy plan construction.

## Install

```sh
pnpm add @ozby/cloudflare
```

Add to `.npmrc`:

```ini
@ozby:registry=https://npm.pkg.github.com
```

## Contact forms

`createCloudflareContactFormHandler` validates configured fields, verifies a Cloudflare Turnstile token server-side, sends an internal Cloudflare Email Sending message with the customer's email as `replyTo`, then sends a customer confirmation. Internal email failure redirects with `contact=email`; confirmation failure still redirects with success and logs only non-PII metadata.

```ts
import { createCloudflareContactFormHandler } from '@ozby/cloudflare/contact-form'

export type Env = {
  EMAIL: { send(message: unknown): Promise<unknown> }
  CONTACT_TURNSTILE_SECRET_KEY: string
}

const contact = createCloudflareContactFormHandler({
  siteName: 'Example Site',
  from: 'info@example.com',
  internalRecipients: ['ops@example.com'],
  customerEmailField: 'email',
  customerNameField: 'name',
  redirectPath: '/contact',
  subjects: {
    internal: 'New website inquiry',
    confirmation: 'We received your message',
  },
  fields: [
    { name: 'name', label: 'Name', required: true },
    { name: 'email', label: 'Email', required: true, type: 'email' },
    { name: 'message', label: 'Message', required: true, type: 'textarea' },
  ],
})

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/contact') return contact(request, env)
    return new Response('Not found', { status: 404 })
  },
}
```

Wrangler Email Sending binding example:

```jsonc
{
  "send_email": [
    {
      "name": "EMAIL",
      "allowed_sender_addresses": ["info@example.com"]
    }
  ]
}
```

Do not restrict destination addresses when customer confirmations are enabled, because recipients are customer-provided emails.

## Deploy helpers

`createCloudflareDeployAdapter` creates thin, site-specific deploy plans while keeping script locations explicit and absolute. `resolveCloudflarePreviewLane` canonicalizes `preview_main` to `preview-main`, and `createPreviewWranglerConfig` generates a preview Worker config with a custom-domain route and optional sender-restricted Email binding.

```ts
import { createCloudflareDeployAdapter } from '@ozby/cloudflare/deploy'

const repoRoot = '/workspace/example'
const productionScriptPath = '/workspace/example/infra/deploy/deploy-production.ts'
const previewScriptPath = '/workspace/example/infra/deploy/deploy-preview.ts'

export const deploy = createCloudflareDeployAdapter({
  repoRoot,
  productionScriptPath,
  previewScriptPath,
  app: { domain: 'example.com', workerName: 'example-worker' },
})
```
