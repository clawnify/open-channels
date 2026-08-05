import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, Bot, CheckCheck, RotateCcw, StickyNote, TriangleAlert } from "lucide-react";
import type { Conversation, Message } from "./api";
import { addComment, getMessages, patchConversation, sendReply } from "./api";
import { Avatar, ChannelChip, timeOfDay } from "./ui";

const POLL_MS = 4000;

function OutboundStatus({ message }: { message: Message }) {
  if (message.status === "queued") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning-tint px-2 py-0.5 text-xs text-warning">
        Queued for the agent
      </span>
    );
  }
  if (message.status === "failed") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-danger/30 bg-danger-tint px-2 py-0.5 text-xs text-danger"
        title={message.error ?? undefined}
      >
        <TriangleAlert className="size-3" aria-hidden /> Failed
      </span>
    );
  }
  return <CheckCheck className="size-3.5 text-faint" aria-label="Sent" />;
}

function MessageRow({ message }: { message: Message }) {
  if (message.kind === "system") {
    return (
      <div className="flex items-center justify-center gap-1.5 px-6 text-[0.6875rem] leading-relaxed text-muted">
        <Bot className="size-3 shrink-0" aria-hidden />
        <span>
          {message.body} · {timeOfDay(message.createdAt)}
        </span>
      </div>
    );
  }

  if (message.kind === "comment") {
    return (
      <div className="mx-6 rounded-lg border border-warning/25 bg-warning-tint px-3.5 py-2.5">
        <div className="mb-1 flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-warning">
          <StickyNote className="size-3" aria-hidden />
          Internal note · {message.authorName ?? "Someone"}
        </div>
        <p className="whitespace-pre-wrap text-[0.8125rem] leading-[1.45] text-foreground">{message.body}</p>
      </div>
    );
  }

  const outbound = message.kind === "outbound";
  return (
    <div className={`flex px-6 ${outbound ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[70%] ${outbound ? "items-end" : "items-start"} flex flex-col gap-1`}>
        <div
          className={
            outbound
              ? "rounded-lg border border-border bg-surface px-3.5 py-2.5"
              : "rounded-lg bg-sunken px-3.5 py-2.5"
          }
        >
          <p className="whitespace-pre-wrap text-sm leading-normal text-foreground">{message.body}</p>
        </div>
        <div className="flex items-center gap-1.5 text-[0.6875rem] text-faint">
          {outbound && message.authorName ? <span>{message.authorName}</span> : null}
          <span>{timeOfDay(message.createdAt)}</span>
          {outbound ? <OutboundStatus message={message} /> : null}
        </div>
      </div>
    </div>
  );
}

export function ThreadPane({
  conversation,
  onConversationChanged,
}: {
  conversation: Conversation;
  onConversationChanged: () => void;
}) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const load = useCallback(async () => {
    const { items } = await getMessages(conversation.id);
    setMessages(items);
  }, [conversation.id]);

  useEffect(() => {
    setMessages(null);
    stickToBottom.current = true;
    load().catch(() => {});
    const t = setInterval(() => load().catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Keep the newest message in view unless the reader scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  async function submit() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      if (mode === "reply") await sendReply(conversation.id, body);
      else await addComment(conversation.id, body);
      setDraft("");
      stickToBottom.current = true;
      await load();
      onConversationChanged();
    } finally {
      setSending(false);
    }
  }

  async function toggleStatus() {
    await patchConversation(conversation.id, {
      status: conversation.status === "open" ? "closed" : "open",
    });
    onConversationChanged();
  }

  const contact = conversation.contact;
  const closed = conversation.status === "closed";

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      {/* Toolbar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <Avatar contact={contact} size={8} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[1.25rem] font-bold leading-tight tracking-[-0.01em]">
              {contact.name ?? contact.handle}
            </h1>
            <ChannelChip channel={conversation.channel} />
          </div>
          <p className="truncate text-xs text-muted">
            {contact.handle}
            {conversation.subject ? ` · ${conversation.subject}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={toggleStatus}
          aria-label={closed ? "Reopen conversation" : "Close conversation"}
          className="inline-flex h-8 items-center gap-x-1.5 rounded-sm border border-border bg-surface px-2 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-sunken"
        >
          {closed ? <RotateCcw className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />}
          {closed ? "Reopen" : "Close"}
        </button>
      </header>

      {/* Timeline */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 space-y-4 overflow-y-auto py-5">
        {messages === null ? (
          <p className="pt-16 text-center text-sm text-muted">Loading conversation…</p>
        ) : messages.length === 0 ? (
          <p className="pt-16 text-center text-sm text-muted">
            No messages here yet. They'll appear as soon as your agent mirrors this thread.
          </p>
        ) : (
          messages.map((m) => <MessageRow key={m.id} message={m} />)
        )}
      </div>

      {/* Composer */}
      <footer className="shrink-0 border-t border-border p-4">
        <div className="rounded-lg border border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div className="flex rounded-lg bg-sunken p-0.5" role="tablist" aria-label="Compose mode">
              {(["reply", "note"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={`rounded-sm px-2.5 py-1 text-sm font-medium transition-colors duration-150 ${
                    mode === m
                      ? "border border-border bg-surface text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                      : "text-muted"
                  }`}
                >
                  {m === "reply" ? "Reply" : "Internal note"}
                </button>
              ))}
            </div>
            {mode === "reply" ? (
              <span className="text-[0.6875rem] text-faint">Sent by your agent via {conversation.channel}</span>
            ) : (
              <span className="text-[0.6875rem] text-faint">Never delivered to the contact</span>
            )}
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder={
              mode === "reply"
                ? `Reply to ${contact.name ?? contact.handle}…`
                : "Add a note for your team and your agent…"
            }
            aria-label={mode === "reply" ? "Reply" : "Internal note"}
            className="w-full resize-none bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-faint"
          />
          <div className="flex items-center justify-end px-3 pb-2.5">
            {mode === "reply" ? (
              <button
                type="button"
                onClick={submit}
                disabled={sending || draft.trim() === ""}
                aria-label="Queue reply for sending"
                className="inline-flex h-8 items-center gap-x-1.5 rounded-sm bg-primary px-2 text-sm font-medium text-on-primary transition-colors duration-150 hover:bg-primary-hover disabled:opacity-50"
              >
                {sending ? "Queueing…" : "Send"}
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={sending || draft.trim() === ""}
                aria-label="Add internal note"
                className="inline-flex h-8 items-center gap-x-1.5 rounded-sm border border-border bg-surface px-2 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-sunken disabled:opacity-50"
              >
                {sending ? "Saving…" : "Add note"}
              </button>
            )}
          </div>
        </div>
      </footer>
    </section>
  );
}
