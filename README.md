# LendLoop

A small neighborhood tool-lending board. **Borrow what you need. Lend what you don’t.** This is a locally reviewable take-home implementation. It has no demo records: the public shelf and member board read live Convex data, and an unconfigured backend is shown as unconfigured.

## Stack and local ports

- Next.js 16 App Router, React 19, TypeScript
- Clerk 7 for sign-in and session identity
- Convex 1.49 for records, authorization, transactions, scheduled outbox delivery, and HTTP actions
- n8n 2.46.6 self-hosted through Docker Compose
- App: `http://localhost:4100`; n8n: `http://localhost:5678`; anonymous local Convex uses its CLI managed ports (typically 3210/3211)

This project is isolated from the parent portfolio. The app script binds to port 4100.

## Local setup

### 1. Install and configure Clerk

```sh
bun install
cp .env.example .env.local
```

Create or select a Clerk **development** application, then put its publishable key in `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, its secret key in `CLERK_SECRET_KEY`, and its Frontend API issuer URL in `CLERK_JWT_ISSUER_DOMAIN`. Keep the secret key server-only. Current Clerk for Next.js needs real development keys; no fake sign-in path is included. The sign-in button is disabled until the publishable key exists.

Enable Clerk's Convex integration for the same application so Clerk issues the Convex audience expected by `convex/auth.config.ts` (`applicationID: "convex"`). Copy the instance issuer URL exactly into `CLERK_JWT_ISSUER_DOMAIN` and the local Convex environment below. This app does not trust Clerk public metadata for roles.

For a new setup, Clerk's current supported CLI flow is `npx -y clerk@latest init`; it can provision an accountless development application. The isolated runtime checks used an unclaimed development application and two fictional users. No application was claimed. Configure your own application before running the demo; the review source includes no provider credentials or test-user details.

### 2. Start an anonymous local Convex backend

Create and select an anonymous local deployment, then configure the Clerk issuer **before** syncing functions (Convex checks auth config during the first sync):

```sh
bunx convex deployment create local --type dev --select
# If you already have Clerk development keys, use their Frontend API issuer URL here.
# Otherwise, keep this reserved placeholder until a real Clerk app is configured.
bunx convex env set CLERK_JWT_ISSUER_DOMAIN https://placeholder.invalid
bunx convex dev
```

`bunx convex dev` starts the persistent local backend, generates `convex/_generated/`, and writes the app URL to `.env.local`. It does not require a Convex account or cloud deployment. `https://placeholder.invalid` cannot authenticate Clerk tokens; replace it with `https://YOUR-CLERK-INSTANCE.clerk.accounts.dev` before signing in. In a second terminal, set remaining Convex values on the local deployment:

```sh
bunx convex env set ADMIN_CLERK_IDS clerk_user_id_1,clerk_user_id_2
bunx convex env set N8N_WEBHOOK_URL http://127.0.0.1:5678/webhook/lendloop-events
```

The admin allowlist is optional; without it, every identity is a regular user. `ADMIN_CLERK_IDS` is read only by Convex from deployment environment and compares to the verified Clerk JWT `subject`. It is never accepted from client metadata or mutation arguments. Generate one random `INTEGRATION_HMAC_SECRET` and set the same value in the local Convex environment and the ignored `.env` used by Compose. Do not commit `.env`, `.env.local`, `.convex/`, or provider keys.

### 3. Start local n8n

Set values in an ignored `.env` file (`cp .env.example .env`). Use a high-entropy `N8N_ENCRYPTION_KEY`, a long random `INTEGRATION_HMAC_SECRET`, and the local Convex HTTP actions URL (normally `http://host.docker.internal:3211`). On Linux, Compose maps `host.docker.internal` to the host gateway. The n8n UI is bound to loopback only.

```sh
docker compose up -d
```

Create the local n8n owner through its first-run UI. Import each JSON file from `n8n/workflows/`. Publish `LendLoop — signed request notification (logged mock)` and `LendLoop — daily overdue reminders (logged mock)` after importing. Set the shared HMAC secret and Convex HTTP URL in the n8n container environment before it starts. The Code nodes need `crypto` and environment-variable access, so Compose explicitly sets `NODE_FUNCTION_ALLOW_BUILTIN=crypto` and `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`; the only permitted builtin is `crypto`.

Import `LendLoop — workflow failure visibility`, then open the settings for each operational workflow and select it as that workflow’s **Error Workflow**. n8n requires this connection to be selected after import. Execution history is saved for diagnosis; the error workflow records only workflow name, execution ID, failed node, and a bounded error string. Never attach an email, Slack, Discord, or other message sender to these demo flows.

### 4. Run the app

```sh
bun run dev
```

Visit `http://localhost:4100`. The `/dashboard` route requires a Clerk session. The public page returns only tool name and category; owner, condition, description, loan state, and identity references stay behind the signed-in Convex query.

## Architecture and authorization

- `app/page.tsx` renders the public Convex projection on the server. If Convex is not connected, it displays a setup message rather than invented data.
- `components/Dashboard.tsx` uses the Clerk-backed Convex client for live, reactive member views and mutations. Clerk/Convex providers mount only when both configuration URLs are present.
- `convex/schema.ts` defines listings, loan snapshots, a durable outbox, persisted mock-notification activity, replay nonces, and trusted-lender grants.
- Every member query and mutation derives identity from `ctx.auth.getUserIdentity()`. Every owner check, participant check, and admin check runs in Convex. The browser’s admin query only controls presentation; privileged functions repeat the allowlist check.
- Admins can archive any listing, inspect all loans, and mark a lender trusted. Users can only change their own listings and act on loans involving them. Listing removal is a soft archive, so active/history loan records and their item snapshots remain intact.
- Inputs are validated server-side. The server rejects self-borrowing, malformed/impossible/past date ranges, ranges longer than 31 days, and overlapping approved bookings. Convex mutation transactions serialize competing approvals and recheck the overlap before changing a request to approved.
- Personal email addresses and profile names are not collected or copied into Convex. The app uses Clerk subject references only where access control needs them. The public query explicitly maps to `{id, name, category}`.

## Automation and integration security

The app uses no live notification providers. Both workflows create **logged mock notifications only**.

1. Creating or changing a request writes an outbox record with immutable event status, recipient, and minimal item/category/date snapshot in the same Convex mutation, then schedules delivery. The Convex action serializes that snapshot rather than rereading mutable loan state. The webhook waits for the last workflow node, so Convex records delivery only after signature verification and the idempotent Convex mock-log write-back finish. Legacy local outbox rows without snapshots stay visible and fail with an explicit manual-review error; they are never silently rewritten from current loan state.
2. The published n8n daily scheduler fetches overdue loans from a signed Convex HTTP action, emits one mock reminder per returned loan, and writes the reminder result to Convex. The reminder key is `overdue:<loanId>:<UTC-date>`; a unique Convex index and one mutation make concurrent/retried write-backs idempotent. Event notifications use the same pattern with `event:<eventKey>`.
3. HTTP Request nodes retry transient errors four times. Convex outbox delivery then retries with bounded exponential delays, up to eight attempts. The admin view exposes exhausted deliveries and their concise last error. n8n saves execution history and its attached Error Workflow receives failures.

Both directions sign the **whole logical request**, not a selectively signed subset. The exact UTF-8 message is:

```text
HTTP_METHOD + "\n" + URL_PATH + "\n" + UNIX_TIMESTAMP_SECONDS + "\n" + NONCE + "\n" + CANONICAL_JSON_BODY
```

Canonical JSON sorts object keys recursively, preserves array order, uses JSON string escaping, and has no insignificant whitespace. HMAC-SHA-256 is lowercase hex. The receiver checks POST, the actual path, a five-minute timestamp window, a bounded random nonce, and a constant-time signature comparison. In one Convex transaction, it binds the nonce to the path, timestamp, signature, and canonical body, executes the idempotent operation, and stores the response. An exact retry during the signature window gets that stored response, which handles a lost HTTP response without weakening replay protection. Reusing a nonce with different signed content is rejected; an operation error rolls back the nonce claim so a transient retry can proceed. Expired entries are pruned in bounded batches. The n8n event receiver uses the webhook path `/webhook/lendloop-events`; outbound Convex routes are `/lendloop/automation/overdue`, `/lendloop/automation/event`, and `/lendloop/automation/reminder`.

Network delivery is **at least once**. The mock log is deduplicated transactionally by stable event/reminder key, so retries and competing runs do not create duplicate records. This does not claim exactly-once delivery for a future external email or chat provider. A production sender would need an idempotency-capable provider or an explicit delivery ledger and would still handle ambiguous timeouts carefully.

Because the Code nodes read an environment secret, the local Compose setup opens only n8n’s `crypto` builtin and Code-node environment access. Restrict n8n to trusted operators and keep it loopback-bound in this demo. For production, move the HMAC key to a managed secret store and use a credential-backed signing node/custom node or a narrowly scoped worker so workflow authors cannot read unrelated process environment. Keep the n8n encryption key stable, use HTTPS/private networking, and set a defined execution-data retention/redaction policy.

## Validation

```sh
bun run typecheck
bun run lint
bun run test
bunx convex dev --once
bun run build
```

`tests/lendloop.test.ts` exercises the actual Convex handlers and HTTP routes with `convex-test`: missing identity, owner isolation, public DTO privacy, archive/history preservation, self-borrow and date checks, lender-only decisions, concurrent booking approval, participant-only returns, overdue/returned/future availability, delayed event snapshots and recipients, admin allowlist restrictions, HMAC tamper/path/method/stale timestamp checks, exact signed-request replay and changed-binding rejection, concurrent idempotent reminder write-backs, and exhausted outbox retry visibility. These tests exercise function logic with simulated verified Convex identities; they are not a substitute for a live Clerk JWT/browser sign-in.

In a separate isolated development setup, two real Clerk browser sessions passed initial dashboard navigation, full-page reload, and the interactive create → request → approve → return flow. Convex queries wait for backend authentication before subscribing. Checks using those sessions also confirmed cross-owner and admin access denials and the minimal public projection. This verifies the development flow, not a production identity deployment.

The exported workflows use the current n8n Webhook, Schedule Trigger, Code, and HTTP Request node formats. The Code nodes use n8n’s documented `$input` API and require only the allowed `crypto` builtin. The export JSON is inactive by default and must be imported, connected to the Error Workflow, then published in n8n. Runtime checks used n8n 2.46.6 through its CLI with local Convex and private test copies: signed webhook write-back and duplicate suppression passed; an accelerated schedule completed twelve runs; a bound error workflow completed five runs; and a deliberately dropped response was recovered by an identical signed retry, with one persisted notification. A changed body using the same nonce was rejected. The exported daily 06:00 trigger was not observed at its actual wall-clock time. Docker was unavailable, so the provided Compose configuration was not runtime-tested.

## Production changes

Use a claimed Clerk production instance and production keys, a dedicated production Convex deployment with the Clerk JWT issuer configured, a real admin identity approval process, and an HTTPS-reachable n8n deployment. Store the signing and encryption keys in a managed vault, rotate them with an overlap plan, and keep workflow editing permissions tightly scoped. Add explicit retention/deletion for outbox, nonce, and activity records; rate limits and abuse monitoring; backups and restoration drills; structured audit events; and production-safe error redaction. Before adding any real notification channel, decide what information may leave the application, obtain consent, and design provider-side idempotency and delivery reconciliation.

## AI assistance and limits

An LLM assisted implementation, documentation, and the development checks. The review source contains no employer or client source code, real user data, private CV/profile records, provider credentials, or local provider state. Runtime checks used only fictional development users and synthetic loan data. The source passed 13 tests, TypeScript, ESLint, and a production Next.js build; isolated Clerk/Convex browser and n8n runtime results and their limits are described above. Reviewers must configure their own development providers and secrets. Production sign-in, deployment, notification delivery, and the actual daily 06:00 schedule are outside these checks.
