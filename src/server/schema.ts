import { sqliteTable, text, integer, index, uniqueIndex } from "@clawnify/db";

/**
 * open-channels — one inbox over every channel the org's agent sits on.
 *
 * Data flows in from the agent (POST /api/ingest): the agent mirrors every
 * inbound/outbound channel message here. Replies composed in the UI are
 * written as `outbound` messages with status `queued`; the agent picks them
 * up from GET /api/outbox, sends them through its own channel tools, and
 * confirms via POST /api/messages/:id/status. The app never talks to a
 * channel API directly.
 *
 * Multi-tenancy: every table carries org_id and every query filters by it.
 */

/** A person on the other end of a channel, unique per (org, channel, handle). */
export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey().$default(() => crypto.randomUUID()),
    orgId: text("org_id").notNull(),
    /** Channel this contact lives on: whatsapp | telegram | slack | email | sms | other */
    channel: text("channel").notNull(),
    /** Channel-native address: phone number, email address, @username, member id. */
    handle: text("handle").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    createdAt: text("created_at").notNull().$default(() => new Date().toISOString()),
  },
  (t) => ({
    byOrgHandle: uniqueIndex("contacts_by_org_channel_handle").on(t.orgId, t.channel, t.handle),
  }),
);

/** One thread with one contact on one channel. */
export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey().$default(() => crypto.randomUUID()),
    orgId: text("org_id").notNull(),
    contactId: text("contact_id").notNull(),
    channel: text("channel").notNull(),
    /** Email subject line; null for chat channels. */
    subject: text("subject"),
    /** open | closed */
    status: text("status").notNull().default("open"),
    /** 1 when the latest inbound message hasn't been seen in the UI. */
    unread: integer("unread").notNull().default(0),
    lastMessageAt: text("last_message_at").notNull().$default(() => new Date().toISOString()),
    lastMessagePreview: text("last_message_preview").notNull().default(""),
    createdAt: text("created_at").notNull().$default(() => new Date().toISOString()),
  },
  (t) => ({
    byOrgRecency: index("conversations_by_org_recency").on(t.orgId, t.lastMessageAt),
    byOrgContact: uniqueIndex("conversations_by_org_contact").on(t.orgId, t.contactId),
  }),
);

/**
 * Everything that happens in a thread, in one timeline:
 *   kind=inbound   — a message from the contact
 *   kind=outbound  — a message to the contact (status: queued → sent | failed)
 *   kind=system    — an agent action audit line ("Drafted a reply", "Escalated…")
 *   kind=comment   — an internal note, never delivered to the contact
 */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey().$default(() => crypto.randomUUID()),
    orgId: text("org_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    /** Display name of who wrote it: the contact, "Agent", or a dashboard user's name. */
    authorName: text("author_name"),
    /** Dashboard user id when a signed-in person wrote it (reply or comment). */
    userId: text("user_id"),
    /** Outbound delivery state: queued | sent | failed. Null for other kinds. */
    status: text("status"),
    /** Failure detail when status=failed. */
    error: text("error"),
    /** Channel-native message id — makes ingest idempotent. */
    externalId: text("external_id"),
    createdAt: text("created_at").notNull().$default(() => new Date().toISOString()),
  },
  (t) => ({
    byConversation: index("messages_by_conversation").on(t.conversationId, t.createdAt),
    byOrgExternal: uniqueIndex("messages_by_org_external").on(t.orgId, t.externalId),
    byOrgQueued: index("messages_by_org_status").on(t.orgId, t.status),
  }),
);
