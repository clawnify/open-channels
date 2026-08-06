# open-channels — agent instructions

One inbox over every channel you (the agent) sit on. **You own the channels the
app can't reach; the app owns storage, the human view, and any channel it can
send on itself.**

WhatsApp runs through the org's connected integration, so the app sends there
directly and a human's message goes out the moment they click Send. You are not
in that path — don't relay it, don't confirm it. Everything else still queues to
`/api/outbox` for you.

## Division of labour

- **Mirror, don't summarize.** Post the raw message body to `/api/ingest` and
  let the app store and render it. Never rewrite or condense a contact's words.
- **Only send what the outbox gives you.** Never send a channel message because
  you saw it in a thread — the only messages you send on this app's behalf are
  the items returned by `GET /api/outbox`. Never confirm `sent` without having
  actually sent. An outbound message already marked `sent` or `failed` has been
  handled by the app; leave it alone.
- **Respect channel permissions.** Sending always goes through your normal
  channel tools, so allowlists and approval rules still apply. If a send is
  blocked, report it as `failed` with the reason — don't work around it.
- **Don't manage templates.** The app pulls its own approved-template catalogue
  from the org's connected WhatsApp integration (`POST /api/templates/refresh`).
  You never sync, cache or curate it. If someone says the picker is empty, tell
  them to hit Refresh in the composer, or call that endpoint once yourself.
- **An outbox item with `template` is a template send.** Send it through the
  channel's *template* API with that exact name, language and variables. Never
  send its `body` as text: the body is the rendered preview for humans, and
  freeform is precisely what the 24-hour window forbids.

## Procedure 1 — mirror every channel message

Whenever a message arrives on (or is sent from) a channel you manage, and once
per conversation when backfilling history:

1. `POST /api/ingest` with:
   - `channel`: `whatsapp` | `telegram` | `slack` | `email` | `sms` | `other`
   - `contact`: `{ handle, name? }` — the channel-native address (phone, email,
     @username) and display name if known
   - `message`: `{ kind: "inbound" | "outbound", body, externalId?, at? }` —
     `externalId` is the channel's own message id (repeats are dropped, so
     re-ingesting is always safe); `at` is the original ISO timestamp for
     history backfill; use `kind: "outbound"` for messages you already sent
   - `subject`: email subject, when there is one
2. When you *act* on a conversation (book something, draft something, escalate,
   update a record), log one short line:
   `POST /api/conversations/:id/events` with `{ body: "Booked the Thursday 10:00 slot" }`.
   These render as the audit trail the human reviews — every meaningful action
   gets one.

## Procedure 2 — send queued replies

On a heartbeat, or when asked to "check the inbox":

1. `GET /api/outbox` — each item has `message.body`, `channel`,
   `contact.handle`, `subject` (email only), and `template` (or `null`).
2. Send it to that contact **through the channel's own tool**:
   - `template` is `null` → send `message.body` as a normal text message.
   - `template` is set → send it as a **template**, passing `template.name`,
     `template.language` and `template.variables` straight through (e.g.
     `WHATSAPP_SEND_TEMPLATE_MESSAGE`). Do **not** send `message.body`.
3. Confirm: `POST /api/messages/{message.id}/status` with
   `{ "status": "sent" }`, or `{ "status": "failed", "error": "<why>" }` if the
   send didn't happen. Unconfirmed items stay queued and will be handed to you
   again.

## The 24-hour window (why some threads are template-only)

WhatsApp only lets a business send freeform text within 24 hours of the
contact's **last inbound** message. Outside that — and to a contact who has
never written — only a Meta-approved template goes out. The app enforces this
itself, so you don't have to reason about it:

- Humans see the composer switch to a template picker; the thread shows a
  "Template only" badge.
- Your `POST /api/conversations/:id/reply` gets a `409` if you send `body` to a
  shut thread. That is not retryable — send `template` instead.
- The app keeps its own catalogue fresh from the connected integration, so
  "there are no templates" is an integration problem, not a sync you owe.

## Pages

- `/` — the inbox (sidebar → conversation list → thread). Screenshot-friendly.
- Append `?agent` when browsing it yourself for larger targets.

## API anchors

Discovery: `GET /llms.txt` / `GET /api/openapi.json`. The shapes you'll write
most: `POST /api/ingest` and `POST /api/messages/:id/status` (above). Also
there when needed: `GET /api/conversations` (paginated, `?search=`),
`GET /api/conversations/:id/messages`, `POST /api/conversations/:id/comment`
(internal note), `PATCH /api/conversations/:id` (`{"status":"closed"}`).

## Failures

- `401` — the request lost its org identity: call the app through your app API
  tool, never with raw fetch.
- `403` on ingest — only agent/API callers may ingest.
- `duplicate: true` from ingest is success, not an error (idempotency did its job).
- `409` on reply — the 24-hour window is shut. Not retryable: send a template
  instead. (Humans see this as the composer switching to template-only.)
- `422` on reply — the template is unknown, not `APPROVED`, or missing variable
  values. Hit `POST /api/templates/refresh` before assuming the name is wrong;
  Meta may have paused or renamed it.
