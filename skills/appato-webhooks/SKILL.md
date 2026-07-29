---
name: appato-webhooks
description: Add public inbound HTTP webhook endpoints to an Appato app with the injected Worker SDK. Use only when an Appato app must receive third-party callbacks, event deliveries, verification challenges, or other requests that cannot use Appato member SSO. Do not use for ordinary authenticated app routes, outbound HTTP calls, scheduled jobs, browser realtime, or general Appato development.
---

# Appato webhooks

Use this together with the `appato` skill. The normal Appato workflow still
owns checkout, editing, pushing, and log inspection; this skill only defines
the inbound webhook contract.

## Register routes

Register webhook routes at module scope in `index.ts`. Registration is local
to the deployed Worker: it creates no platform configuration or durable route
state.

```ts
import { webhooks } from "./_appato.js";

webhooks.post("/events/:eventId", async (request, env, ctx, params) => {
  const rawBody = await request.arrayBuffer();
  // Verify the sender against the untouched bytes before parsing or acting.
  // Then parse, process, and return exactly the response the sender expects.
  return new Response(JSON.stringify({ accepted: params.eventId }), {
    status: 202,
    headers: { "content-type": "application/json" },
  });
});
```

The public endpoint is:

```text
https://<app>-<org>.hooks.appato.app/events/<eventId>
```

Available registration methods are `get`, `post`, `put`, `patch`, `delete`,
`head`, `options`, and `all`.

Patterns support:

- Exact paths: `/events`
- Named segments: `/events/:eventId`, available as `params.eventId`
- A terminal catchall: `/callbacks/*`, available as `params["*"]`

Prefer the narrowest method and path. Use `all` or a catchall only when the
external protocol or runtime-generated callback paths require it. Ambiguous
patterns for the same method are rejected. Registration freezes when the
first webhook request is dispatched, so never register or remove routes from
inside a request handler. For per-user integrations, use a named segment or
catchall and resolve that identifier through app storage; do not create one
route per user at request time.

An unregistered path or method returns `404`. It never falls through to the
app's normal `fetch` handler or static files. The hooks hostname is a separate
public ingress; the authenticated app remains at its normal `appato.app`
hostname: `https://<app>-<org>.appato.app`.

## Handle raw HTTP

The handler receives `(request, env, ctx, params)` and must return a
`Response`. Treat it as a normal Worker request:

- Read headers, query parameters, and the raw body from `request`.
- Read the body only once. If verification and parsing both need it, buffer
  once with `arrayBuffer()` and derive both operations from those exact bytes.
- Return the exact status, body, content type, and redirect headers required
  by the external protocol.
- Use `ctx.waitUntil(...)` for safe follow-up work after a prompt
  acknowledgement when the external protocol does not require synchronous
  results.
- Design side effects to be idempotent. External senders commonly retry the
  same delivery.

Appato preserves the handler's response except that it removes `Set-Cookie`
and internal `x-appato-*` headers, forces `Cache-Control: no-store`, and does
not permit WebSocket upgrades or `101` responses.

## Authenticate in the handler

The hooks gateway intentionally performs no member SSO and no
provider-specific verification. Route registration selects traffic; it is
not authentication. `getUser(request)` has no signed-in user on this ingress.

Implement the sender's authentication protocol in the handler before parsing
or causing side effects. Preserve these invariants:

- Verify signatures against the exact raw request bytes.
- Apply the protocol's timestamp or nonce replay checks when it defines them.
- Compare secret tokens in constant time where the runtime permits.
- Never log credentials, authorization headers, signatures, full request
  bodies, or verification material.
- Never commit a secret to app files. If the required credential is not
  available through the Appato runtime, stop and tell the user that secure
  verification needs secret-storage support.

Provider adapters are deliberately not part of Appato V1. Write only the
verification and response behavior required by the external protocol being
integrated; do not add provider-specific platform code.

## Platform limits and diagnostics

- Request body limit: 5 MiB.
- Coarse abuse brake: approximately 1,000 requests per minute per app per
  Cloudflare location. It is not an exact global quota.
- Webhook requests are metered separately and appear in `appato logs` with
  source `webhook` (`Webhooks` in the console UI).
- Platform-generated `429`, `500`, and `503` responses include retry-oriented
  semantics; external senders may retry them.

After pushing, exercise the registered path with a safe representative
request and run `appato logs` before declaring the integration healthy.
