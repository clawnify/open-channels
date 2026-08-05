import { OpenAPIHono, createRoute, z, user, orgId, caller } from "@clawnify/app";
import { getDB, and, or, eq, desc, asc, lt, like, count, sql } from "@clawnify/db";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

type Env = { Bindings: { DB: D1Database } };
const api = new OpenAPIHono<Env>();

// getDB returns a D1 | Facet union whose generic select(fields) overloads
// collapse on the union type. Both backends share the same query surface, so
// narrow once here (type-only — drizzle-orm is a devDependency for this import).
type DB = DrizzleD1Database<typeof schema>;
const dbFor = (env: Env["Bindings"]) => getDB(env, { schema }) as DB;

/* ---------------------------------- shapes --------------------------------- */

const CHANNELS = ["whatsapp", "telegram", "slack", "email", "sms", "other"] as const;

const ContactSchema = z
  .object({
    id: z.string(),
    channel: z.string(),
    handle: z.string(),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  })
  .openapi("Contact");

const ConversationSchema = z
  .object({
    id: z.string(),
    channel: z.string(),
    subject: z.string().nullable(),
    status: z.string(),
    unread: z.number(),
    lastMessageAt: z.string(),
    lastMessagePreview: z.string(),
    contact: ContactSchema,
  })
  .openapi("Conversation");

const MessageSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    kind: z.string(),
    body: z.string(),
    authorName: z.string().nullable(),
    status: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("Message");

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const OkSchema = z.object({ ok: z.boolean() }).openapi("Ok");

const jsonBody = <T extends z.ZodTypeAny>(s: T) => ({
  content: { "application/json": { schema: s } },
});
const jsonRes = <T extends z.ZodTypeAny>(s: T, description: string) => ({
  description,
  content: { "application/json": { schema: s } },
});

const preview = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 140);

const toConversation = (
  conv: typeof schema.conversations.$inferSelect,
  contact: typeof schema.contacts.$inferSelect,
) => ({
  id: conv.id,
  channel: conv.channel,
  subject: conv.subject,
  status: conv.status,
  unread: conv.unread,
  lastMessageAt: conv.lastMessageAt,
  lastMessagePreview: conv.lastMessagePreview,
  contact: {
    id: contact.id,
    channel: contact.channel,
    handle: contact.handle,
    name: contact.name,
    avatarUrl: contact.avatarUrl,
  },
});

const toMessage = (m: typeof schema.messages.$inferSelect) => ({
  id: m.id,
  conversationId: m.conversationId,
  kind: m.kind,
  body: m.body,
  authorName: m.authorName,
  status: m.status,
  error: m.error,
  createdAt: m.createdAt,
});

/** Loads a conversation scoped to the caller's org; null means 404 or no org. */
async function findConversation(
  c: { env: Env["Bindings"]; req: { header(name: string): string | undefined } },
  id: string,
) {
  const org = orgId(c);
  if (!org) return null;
  const db = dbFor(c.env);
  const [row] = await db
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.orgId, org), eq(schema.conversations.id, id)))
    .limit(1);
  return row ?? null;
}

/* ---------------------------------- ingest --------------------------------- */

const IngestSchema = z
  .object({
    channel: z.enum(CHANNELS),
    contact: z.object({
      handle: z.string().min(1),
      name: z.string().optional(),
      avatarUrl: z.string().url().optional(),
    }),
    message: z.object({
      kind: z.enum(["inbound", "outbound"]).default("inbound"),
      body: z.string().min(1),
      externalId: z.string().optional(),
      at: z.string().datetime().optional(),
      authorName: z.string().optional(),
    }),
    subject: z.string().optional(),
  })
  .openapi("Ingest");

api.openapi(
  createRoute({
    method: "post",
    path: "/api/ingest",
    summary: "Ingest a channel message (agent only)",
    description:
      "Mirror one inbound or outbound channel message into the inbox. Creates the contact and conversation on first sight, reopens closed conversations on new inbound, and is idempotent on message.externalId. Use kind=outbound for messages the agent already sent itself (history sync).",
    request: { body: jsonBody(IngestSchema) },
    responses: {
      200: jsonRes(
        z
          .object({ conversationId: z.string(), messageId: z.string().nullable(), duplicate: z.boolean() })
          .openapi("IngestResult"),
        "Ingest result",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
      403: jsonRes(ErrorSchema, "Caller may not ingest"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const who = caller(c);
    if (who !== "agent" && who !== "api" && who !== "system") {
      return c.json({ error: "only the agent may ingest messages" }, 403);
    }

    const input = c.req.valid("json");
    const db = dbFor(c.env);
    const now = new Date().toISOString();
    const at = input.message.at ?? now;

    // Contact: find or create; refresh name/avatar when provided.
    let [contact] = await db
      .select()
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.orgId, org),
          eq(schema.contacts.channel, input.channel),
          eq(schema.contacts.handle, input.contact.handle),
        ),
      )
      .limit(1);
    if (!contact) {
      [contact] = await db
        .insert(schema.contacts)
        .values({
          orgId: org,
          channel: input.channel,
          handle: input.contact.handle,
          name: input.contact.name ?? null,
          avatarUrl: input.contact.avatarUrl ?? null,
        })
        .returning();
    } else if (
      (input.contact.name && input.contact.name !== contact.name) ||
      (input.contact.avatarUrl && input.contact.avatarUrl !== contact.avatarUrl)
    ) {
      [contact] = await db
        .update(schema.contacts)
        .set({
          name: input.contact.name ?? contact.name,
          avatarUrl: input.contact.avatarUrl ?? contact.avatarUrl,
        })
        .where(eq(schema.contacts.id, contact.id))
        .returning();
    }

    // Conversation: one per contact; new inbound reopens a closed thread.
    let [conv] = await db
      .select()
      .from(schema.conversations)
      .where(and(eq(schema.conversations.orgId, org), eq(schema.conversations.contactId, contact.id)))
      .limit(1);
    if (!conv) {
      [conv] = await db
        .insert(schema.conversations)
        .values({
          orgId: org,
          contactId: contact.id,
          channel: input.channel,
          subject: input.subject ?? null,
          lastMessageAt: at,
          lastMessagePreview: preview(input.message.body),
        })
        .returning();
    }

    // Idempotency: same externalId → acknowledge without inserting.
    if (input.message.externalId) {
      const [dupe] = await db
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(
          and(eq(schema.messages.orgId, org), eq(schema.messages.externalId, input.message.externalId)),
        )
        .limit(1);
      if (dupe) return c.json({ conversationId: conv.id, messageId: dupe.id, duplicate: true }, 200);
    }

    const inbound = input.message.kind === "inbound";
    const [msg] = await db
      .insert(schema.messages)
      .values({
        orgId: org,
        conversationId: conv.id,
        kind: input.message.kind,
        body: input.message.body,
        authorName: input.message.authorName ?? (inbound ? contact.name ?? contact.handle : "Agent"),
        status: inbound ? null : "sent",
        externalId: input.message.externalId ?? null,
        createdAt: at,
      })
      .returning();

    await db
      .update(schema.conversations)
      .set({
        subject: input.subject ?? conv.subject,
        // History backfill can arrive out of order — only advance the clock.
        ...(at >= conv.lastMessageAt
          ? { lastMessageAt: at, lastMessagePreview: preview(input.message.body) }
          : {}),
        ...(inbound ? { unread: 1, status: "open" } : {}),
      })
      .where(eq(schema.conversations.id, conv.id));

    return c.json({ conversationId: conv.id, messageId: msg.id, duplicate: false }, 200);
  },
);

/* ------------------------------- conversations ----------------------------- */

api.openapi(
  createRoute({
    method: "get",
    path: "/api/conversations",
    summary: "List conversations",
    description:
      "Paginated inbox, most recent first. Filter by channel and status (default open); search matches contact name/handle and the last message preview.",
    request: {
      query: z.object({
        channel: z.enum(CHANNELS).optional(),
        status: z.enum(["open", "closed", "all"]).default("open"),
        search: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    },
    responses: {
      200: jsonRes(
        z.object({ items: z.array(ConversationSchema), total: z.number() }).openapi("ConversationPage"),
        "One page of conversations",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const q = c.req.valid("query");
    const db = dbFor(c.env);

    const filters = [eq(schema.conversations.orgId, org)];
    if (q.channel) filters.push(eq(schema.conversations.channel, q.channel));
    if (q.status !== "all") filters.push(eq(schema.conversations.status, q.status));
    if (q.search) {
      const term = `%${q.search}%`;
      filters.push(
        or(
          like(schema.contacts.name, term),
          like(schema.contacts.handle, term),
          like(schema.conversations.lastMessagePreview, term),
        )!,
      );
    }
    const where = and(...filters);

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({ conv: schema.conversations, contact: schema.contacts })
        .from(schema.conversations)
        .innerJoin(schema.contacts, eq(schema.conversations.contactId, schema.contacts.id))
        .where(where)
        .orderBy(desc(schema.conversations.lastMessageAt))
        .limit(q.limit)
        .offset(q.offset),
      db
        .select({ total: count() })
        .from(schema.conversations)
        .innerJoin(schema.contacts, eq(schema.conversations.contactId, schema.contacts.id))
        .where(where),
    ]);

    return c.json({ items: rows.map((r) => toConversation(r.conv, r.contact)), total }, 200);
  },
);

api.openapi(
  createRoute({
    method: "get",
    path: "/api/stats",
    summary: "Inbox counts for the sidebar",
    description: "Open/unread totals, per-channel open counts, and the queued-outbound count.",
    responses: {
      200: jsonRes(
        z
          .object({
            totalOpen: z.number(),
            totalUnread: z.number(),
            queued: z.number(),
            channels: z.array(z.object({ channel: z.string(), open: z.number() })),
          })
          .openapi("Stats"),
        "Inbox counts",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const db = dbFor(c.env);

    const open = and(eq(schema.conversations.orgId, org), eq(schema.conversations.status, "open"));
    const [channels, [totals], [queued]] = await Promise.all([
      db
        .select({ channel: schema.conversations.channel, open: count() })
        .from(schema.conversations)
        .where(open)
        .groupBy(schema.conversations.channel),
      db
        .select({
          totalOpen: count(),
          totalUnread: sql<number>`coalesce(sum(${schema.conversations.unread}), 0)`,
        })
        .from(schema.conversations)
        .where(open),
      db
        .select({ queued: count() })
        .from(schema.messages)
        .where(and(eq(schema.messages.orgId, org), eq(schema.messages.status, "queued"))),
    ]);

    return c.json(
      {
        totalOpen: totals.totalOpen,
        totalUnread: Number(totals.totalUnread),
        queued: queued.queued,
        channels,
      },
      200,
    );
  },
);

const IdParam = z.object({ id: z.string() });

api.openapi(
  createRoute({
    method: "get",
    path: "/api/conversations/:id",
    summary: "Get one conversation",
    request: { params: IdParam },
    responses: {
      200: jsonRes(ConversationSchema, "The conversation"),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "Not found"),
    },
  }),
  async (c) => {
    const conv = await findConversation(c, c.req.valid("param").id);
    if (!conv) return c.json({ error: "not found" }, orgId(c) ? 404 : 401);
    const db = dbFor(c.env);
    const [contact] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, conv.contactId))
      .limit(1);
    return c.json(toConversation(conv, contact), 200);
  },
);

api.openapi(
  createRoute({
    method: "get",
    path: "/api/conversations/:id/messages",
    summary: "List messages in a conversation",
    description:
      "Chronological page of the thread — inbound/outbound messages, agent audit lines (kind=system) and internal notes (kind=comment). Use before=<ISO timestamp> to page further back.",
    request: {
      params: IdParam,
      query: z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.string().optional(),
      }),
    },
    responses: {
      200: jsonRes(
        z.object({ items: z.array(MessageSchema), hasMore: z.boolean() }).openapi("MessagePage"),
        "One page of messages, oldest first",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "Not found"),
    },
  }),
  async (c) => {
    const conv = await findConversation(c, c.req.valid("param").id);
    if (!conv) return c.json({ error: "not found" }, orgId(c) ? 404 : 401);
    const q = c.req.valid("query");
    const db = dbFor(c.env);

    const filters = [eq(schema.messages.conversationId, conv.id)];
    if (q.before) filters.push(lt(schema.messages.createdAt, q.before));

    // Fetch newest-first to find the page, return oldest-first for rendering.
    const rows = await db
      .select()
      .from(schema.messages)
      .where(and(...filters))
      .orderBy(desc(schema.messages.createdAt))
      .limit(q.limit + 1);

    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit).reverse().map(toMessage);
    return c.json({ items, hasMore }, 200);
  },
);

const ComposeSchema = z.object({ body: z.string().min(1) }).openapi("Compose");

api.openapi(
  createRoute({
    method: "post",
    path: "/api/conversations/:id/reply",
    summary: "Queue a reply to the contact",
    description:
      "Writes an outbound message with status=queued. The org's agent picks it up from GET /api/outbox, sends it through the conversation's channel, then confirms via POST /api/messages/:id/status. The app never sends directly.",
    request: { params: IdParam, body: jsonBody(ComposeSchema) },
    responses: {
      201: jsonRes(MessageSchema, "The queued outbound message"),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "Not found"),
    },
  }),
  async (c) => {
    const conv = await findConversation(c, c.req.valid("param").id);
    if (!conv) return c.json({ error: "not found" }, orgId(c) ? 404 : 401);
    const { body } = c.req.valid("json");
    const u = user(c);
    const db = dbFor(c.env);
    const now = new Date().toISOString();

    const [msg] = await db
      .insert(schema.messages)
      .values({
        orgId: conv.orgId,
        conversationId: conv.id,
        kind: "outbound",
        body,
        status: "queued",
        authorName: u?.name ?? u?.email ?? "Agent",
        userId: u?.id ?? null,
        createdAt: now,
      })
      .returning();

    await db
      .update(schema.conversations)
      .set({ lastMessageAt: now, lastMessagePreview: preview(body), unread: 0 })
      .where(eq(schema.conversations.id, conv.id));

    return c.json(toMessage(msg), 201);
  },
);

api.openapi(
  createRoute({
    method: "post",
    path: "/api/conversations/:id/comment",
    summary: "Add an internal note",
    description: "A note visible only in this inbox — never delivered to the contact.",
    request: { params: IdParam, body: jsonBody(ComposeSchema) },
    responses: {
      201: jsonRes(MessageSchema, "The note"),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "Not found"),
    },
  }),
  async (c) => {
    const conv = await findConversation(c, c.req.valid("param").id);
    if (!conv) return c.json({ error: "not found" }, orgId(c) ? 404 : 401);
    const { body } = c.req.valid("json");
    const u = user(c);
    const db = dbFor(c.env);

    const [msg] = await db
      .insert(schema.messages)
      .values({
        orgId: conv.orgId,
        conversationId: conv.id,
        kind: "comment",
        body,
        authorName: u?.name ?? u?.email ?? (caller(c) === "agent" ? "Agent" : "Someone"),
        userId: u?.id ?? null,
      })
      .returning();
    return c.json(toMessage(msg), 201);
  },
);

api.openapi(
  createRoute({
    method: "post",
    path: "/api/conversations/:id/events",
    summary: "Log an agent action on the conversation (audit line)",
    description:
      'Appends a kind=system line to the thread — the audit trail humans review. Log every action taken on this conversation: "Drafted a reply for review", "Booked the appointment", "Escalated to Sara".',
    request: { params: IdParam, body: jsonBody(ComposeSchema) },
    responses: {
      201: jsonRes(MessageSchema, "The audit line"),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "Not found"),
    },
  }),
  async (c) => {
    const conv = await findConversation(c, c.req.valid("param").id);
    if (!conv) return c.json({ error: "not found" }, orgId(c) ? 404 : 401);
    const { body } = c.req.valid("json");
    const db = dbFor(c.env);
    const [msg] = await db
      .insert(schema.messages)
      .values({
        orgId: conv.orgId,
        conversationId: conv.id,
        kind: "system",
        body,
        authorName: "Agent",
      })
      .returning();
    return c.json(toMessage(msg), 201);
  },
);

api.openapi(
  createRoute({
    method: "patch",
    path: "/api/conversations/:id",
    summary: "Update conversation state",
    description: "Close/reopen the thread or clear its unread flag.",
    request: {
      params: IdParam,
      body: jsonBody(
        z
          .object({ status: z.enum(["open", "closed"]).optional(), unread: z.literal(0).optional() })
          .openapi("ConversationPatch"),
      ),
    },
    responses: {
      200: jsonRes(OkSchema, "Updated"),
      400: jsonRes(ErrorSchema, "Empty patch"),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "Not found"),
    },
  }),
  async (c) => {
    const conv = await findConversation(c, c.req.valid("param").id);
    if (!conv) return c.json({ error: "not found" }, orgId(c) ? 404 : 401);
    const body = c.req.valid("json");
    const patch: Partial<typeof schema.conversations.$inferInsert> = {};
    if (body.status !== undefined) patch.status = body.status;
    if (body.unread !== undefined) patch.unread = body.unread;
    if (Object.keys(patch).length === 0) return c.json({ error: "empty patch" }, 400);
    const db = dbFor(c.env);
    await db.update(schema.conversations).set(patch).where(eq(schema.conversations.id, conv.id));
    return c.json({ ok: true }, 200);
  },
);

/* ---------------------------------- outbox --------------------------------- */

api.openapi(
  createRoute({
    method: "get",
    path: "/api/outbox",
    summary: "Queued replies waiting to be sent (agent only)",
    description:
      "Outbound messages with status=queued, oldest first, with the channel and contact handle to send to. After sending each one through the channel, confirm with POST /api/messages/:id/status.",
    request: {
      query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(25) }),
    },
    responses: {
      200: jsonRes(
        z
          .object({
            items: z.array(
              z
                .object({
                  message: MessageSchema,
                  channel: z.string(),
                  contact: ContactSchema,
                  subject: z.string().nullable(),
                })
                .openapi("OutboxItem"),
            ),
          })
          .openapi("Outbox"),
        "Queued outbound messages",
      ),
      401: jsonRes(ErrorSchema, "No org identity"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const { limit } = c.req.valid("query");
    const db = dbFor(c.env);

    const rows = await db
      .select({ message: schema.messages, conv: schema.conversations, contact: schema.contacts })
      .from(schema.messages)
      .innerJoin(schema.conversations, eq(schema.messages.conversationId, schema.conversations.id))
      .innerJoin(schema.contacts, eq(schema.conversations.contactId, schema.contacts.id))
      .where(and(eq(schema.messages.orgId, org), eq(schema.messages.status, "queued")))
      .orderBy(asc(schema.messages.createdAt))
      .limit(limit);

    return c.json(
      {
        items: rows.map((r) => ({
          message: toMessage(r.message),
          channel: r.conv.channel,
          subject: r.conv.subject,
          contact: {
            id: r.contact.id,
            channel: r.contact.channel,
            handle: r.contact.handle,
            name: r.contact.name,
            avatarUrl: r.contact.avatarUrl,
          },
        })),
      },
      200,
    );
  },
);

api.openapi(
  createRoute({
    method: "post",
    path: "/api/messages/:id/status",
    summary: "Confirm delivery of a queued reply (agent only)",
    request: {
      params: IdParam,
      body: jsonBody(
        z
          .object({ status: z.enum(["sent", "failed"]), error: z.string().optional() })
          .openapi("DeliveryStatus"),
      ),
    },
    responses: {
      200: jsonRes(OkSchema, "Recorded"),
      401: jsonRes(ErrorSchema, "No org identity"),
      404: jsonRes(ErrorSchema, "Not found"),
    },
  }),
  async (c) => {
    const org = orgId(c);
    if (!org) return c.json({ error: "unauthorized" }, 401);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = dbFor(c.env);

    const [row] = await db
      .update(schema.messages)
      .set({ status: body.status, error: body.status === "failed" ? body.error ?? "send failed" : null })
      .where(and(eq(schema.messages.orgId, org), eq(schema.messages.id, id)))
      .returning({ id: schema.messages.id });
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true }, 200);
  },
);

export default api;
