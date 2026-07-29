---
name: appato-webhooks
description: Provision and implement public inbound HTTP webhooks for an Appato app. Use when an app must receive third-party callbacks, event deliveries, verification challenges, or any request that cannot use Appato member SSO. Covers requesting opaque URLs by label, handleWebhook(), sender verification, testing, rotation, and revocation. Do not use for ordinary authenticated app routes, outbound HTTP calls, scheduled jobs, browser realtime, or general Appato development.
---

# Appato webhooks

Use this together with the `appato` skill. The normal Appato workflow owns
checkout, editing, pushing, and logs. This skill owns the public webhook
capability and its code handler.

## Request the webhook first

Every webhook must be provisioned by a builder before it can receive traffic.
From inside the app checkout, choose a descriptive lowercase `snake_case`
label and run:

```sh
appato webhook create slack_message
```

The command is idempotent. It returns the same URL if the label already
exists and ends with:

```text
APPATO_WEBHOOK app=<org>/<app> label="slack_message" url="https://<app>-<org>.hooks.appato.app/<opaque-id>" created_at=<ms> created=<true|false>
```

Use the returned URL exactly when configuring the provider. Never construct,
guess, or derive it. The 43-character path is a cryptographically random
capability and should be handled like a secret: do not put it in app source,
screenshots, issue text, logs, or chat unless the user explicitly needs it.
The platform deliberately does not put that id in the app's request or durable
logs.

Useful operations:

```sh
appato webhook                 # list labels and URLs
appato webhook --json          # structured list
appato webhook delete <label>  # revoke immediately
```

At most 64 webhooks may be provisioned per app. Labels begin with a letter,
contain only lowercase letters, digits, and underscores, and are at most 48
characters. Prefer one label per provider/integration or independent failure
domain, such as `github_push`, `slack_events`, or `stripe_accounting`.

Deleting a label invalidates its URL immediately. Recreating that label mints
a different URL, which is the rotation procedure; update the provider with
the new URL. Provisioned webhooks survive code pushes and rollbacks, and are
deleted with the app.

## Register the label in code

Register the matching label at module scope in `index.ts`:

```ts
import { handleWebhook } from "./_appato.js";

handleWebhook("slack_message", async (request, env, ctx) => {
  const rawBody = await request.arrayBuffer();
  // Verify the sender against these exact bytes before parsing or acting.
  // Then parse/process and return exactly what the provider expects.
  return new Response("accepted", { status: 202 });
});
```

`handleWebhook(label, handler)` creates no URL. The CLI provisioning step
creates the public capability; the label is the stable join between platform
state and deployed code. A provisioned label with no registered handler
returns `404`. A code handler whose label has not been provisioned is
unreachable.

The handler accepts every HTTP method at its one URL. Providers may send GET,
POST, PUT, PATCH, DELETE, HEAD, or OPTIONS; branch on `request.method` when a
protocol needs different behavior. Query parameters, headers, and body are
preserved. The request pathname presented to the handler is `/`; there are no
public subpaths or route parameters. Use separate labeled webhooks or query/
body values when a provider needs distinct event routing.

Registration freezes on the first dispatch. Register only at module scope,
never inside `fetch` or another handler. Duplicate or invalid labels fail
deployment/runtime initialization.

## Handle raw HTTP

The handler receives `(request, env, ctx)` and must return a `Response`:

- Read the body only once. If verification and parsing both need it, buffer
  once with `arrayBuffer()` and derive both from those exact bytes.
- Return the exact status, body, content type, and redirect headers the
  provider requires, including verification challenges.
- Use `ctx.waitUntil(...)` only for safe follow-up work after a prompt
  acknowledgement when synchronous results are not required.
- Make side effects idempotent; webhook senders commonly retry deliveries.

Appato preserves the response except that it removes `Set-Cookie` and
internal `x-appato-*` headers, forces `Cache-Control: no-store`, and rejects
WebSocket upgrades and `101` responses.

## Authenticate the sender

The opaque URL reduces discovery and accidental cross-routing, but it is not
a substitute for provider authentication. The gateway performs no member SSO
or provider-specific verification, and `getUser(request)` has no signed-in
user on webhook ingress.

Implement the provider protocol in the handler before parsing or causing side
effects:

- Verify signatures against the exact raw request bytes.
- Enforce timestamp, nonce, and replay rules when the protocol defines them.
- Compare secret tokens in constant time where the runtime permits.
- Never log credentials, authorization headers, signatures, complete bodies,
  challenge secrets, or the public webhook URL.
- Never commit a provider secret to app files. If secure runtime secret
  storage is unavailable for the required credential, stop and tell the user.

## Verify before finishing

Request/list the label, push the code, configure the exact returned URL at the
provider, and send a safe representative request including any challenge
flow. Then run `appato logs --source webhook`; do not declare the integration
healthy from a successful push alone.

Limits: 5 MiB request body; coarse abuse brake around 1,000 requests/minute
per app per Cloudflare location. Platform `429`, `500`, and `503` responses
are retry-oriented and providers may retry them.
