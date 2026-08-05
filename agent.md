# open-channels — agent instructions

One inbox over every channel you (the agent) sit on. **You own channel I/O; the
app owns storage and the human view.** The app never talks to WhatsApp,
Telegram, Slack or email itself — you mirror messages in, and you send queued
replies out through your own channel tools.

## Division of labour

- **Mirror, don't summarize.** Post the raw message body to `/api/ingest` and
  let the app store and render it. Never rewrite or condense a contact's words.
- **Only send what the outbox gives you.** Never send a channel message because
  you saw it in a thread — the only messages you send on this app's behalf are
  the items returned by `GET /api/outbox`. Never confirm `sent` without having
  actually sent.
- **Respect channel permissions.** Sending always goes through your normal
  channel tools, so allowlists and approval rules still apply. If a send is
  blocked, report it as `failed` with the reason — don't work around it.

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
   `contact.handle`, and `subject` (email only).
2. Send the body to that contact **through the channel's own tool**.
3. Confirm: `POST /api/messages/{message.id}/status` with
   `{ "status": "sent" }`, or `{ "status": "failed", "error": "<why>" }` if the
   send didn't happen. Unconfirmed items stay queued and will be handed to you
   again.

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
