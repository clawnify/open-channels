import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, Inbox, Search } from "lucide-react";
import type { Conversation, Stats } from "./api";
import { getStats, listConversations, patchConversation } from "./api";
import { ThreadPane } from "./thread";
import { Avatar, CHANNELS, ChannelMark, Eyebrow, channelMeta, timeAgo } from "./ui";

const POLL_MS = 5000;
const PAGE_SIZE = 50;

/** Sidebar filter: the whole inbox, one channel, or the closed archive. */
type Filter = { kind: "all" } | { kind: "channel"; channel: string } | { kind: "closed" };

function SidebarRow({
  active,
  onClick,
  icon,
  label,
  count,
  ariaLabel,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-[0.4375rem] text-sm transition-colors duration-150 ${
        active
          ? "bg-primary/12 font-semibold text-primary"
          : "text-foreground hover:bg-sunken"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {count !== undefined && count > 0 ? (
        <span
          className={`text-xs tabular-nums ${active ? "text-primary" : "text-muted"}`}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

function Sidebar({
  stats,
  filter,
  setFilter,
}: {
  stats: Stats | null;
  filter: Filter;
  setFilter: (f: Filter) => void;
}) {
  const channelCount = (ch: string) => stats?.channels.find((c) => c.channel === ch)?.open ?? 0;
  // Only channels that have (or had) conversations show up — plus none-yet hint.
  const activeChannels = Object.keys(CHANNELS).filter((ch) => channelCount(ch) > 0);

  return (
    <aside className="flex w-[16.25rem] shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <Inbox className="size-4 text-foreground" aria-hidden />
        <span className="text-base font-semibold">Channels</span>
        {stats && stats.queued > 0 ? (
          <span className="ml-auto rounded-full border border-warning/30 bg-warning-tint px-2 py-0.5 text-xs text-warning tabular-nums">
            {stats.queued} queued
          </span>
        ) : null}
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto p-3">
        <div className="space-y-1">
          <div className="px-2.5 pb-1.5 pt-1">
            <Eyebrow>Inbox</Eyebrow>
          </div>
          <SidebarRow
            active={filter.kind === "all"}
            onClick={() => setFilter({ kind: "all" })}
            icon={<Inbox className="size-4" aria-hidden />}
            label="All open"
            count={stats?.totalOpen}
            ariaLabel="Show all open conversations"
          />
        </div>

        <div className="space-y-1">
          <div className="px-2.5 pb-1.5">
            <Eyebrow>Channels</Eyebrow>
          </div>
          {activeChannels.length === 0 ? (
            <p className="px-2.5 py-1 text-xs leading-relaxed text-muted">
              No channels yet. Your agent adds one the first time it mirrors a message.
            </p>
          ) : (
            activeChannels.map((ch) => {
              const meta = channelMeta(ch);
              return (
                <SidebarRow
                  key={ch}
                  active={filter.kind === "channel" && filter.channel === ch}
                  onClick={() => setFilter({ kind: "channel", channel: ch })}
                  icon={<ChannelMark channel={ch} className="size-4" />}
                  label={meta.label}
                  count={channelCount(ch)}
                  ariaLabel={`Show ${meta.label} conversations`}
                />
              );
            })
          )}
        </div>

        <div className="space-y-1">
          <div className="px-2.5 pb-1.5">
            <Eyebrow>Views</Eyebrow>
          </div>
          <SidebarRow
            active={filter.kind === "closed"}
            onClick={() => setFilter({ kind: "closed" })}
            icon={<Archive className="size-4" aria-hidden />}
            label="Closed"
            ariaLabel="Show closed conversations"
          />
        </div>
      </nav>

      <div className="border-t border-border p-3">
        <p className="px-1.5 text-[0.6875rem] leading-relaxed text-faint">
          Replies are sent by your AI employee through its own channels — this inbox never
          messages anyone directly.
        </p>
      </div>
    </aside>
  );
}

function ConversationRow({
  conversation,
  active,
  onClick,
}: {
  conversation: Conversation;
  active: boolean;
  onClick: () => void;
}) {
  const name = conversation.contact.name ?? conversation.contact.handle;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open conversation with ${name}`}
      aria-current={active ? "true" : undefined}
      className={`flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left transition-colors duration-150 ${
        active ? "bg-sunken" : "hover:bg-sunken"
      }`}
    >
      <Avatar contact={conversation.contact} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`truncate text-sm ${conversation.unread ? "font-semibold" : "font-medium"}`}
          >
            {name}
          </span>
          <span className="shrink-0 text-[0.6875rem] text-faint tabular-nums">
            {timeAgo(conversation.lastMessageAt)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-[0.8125rem] leading-[1.45] ${
              conversation.unread ? "text-foreground" : "text-muted"
            }`}
          >
            {conversation.lastMessagePreview || "No messages yet"}
          </span>
          {conversation.unread ? (
            <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />
          ) : null}
        </div>
      </div>
    </button>
  );
}

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [search, setSearch] = useState("");
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Agent mode: larger tap targets + no hover-only affordances (index.css).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("agent") || params.get("mode") === "agent") {
      document.documentElement.setAttribute("data-agent", "");
    }
  }, []);

  useEffect(() => {
    clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(searchDebounce.current);
  }, [search]);

  const load = useCallback(async () => {
    const params = {
      status: filter.kind === "closed" ? "closed" : "open",
      channel: filter.kind === "channel" ? filter.channel : undefined,
      search: debouncedSearch || undefined,
      limit: PAGE_SIZE,
    };
    const [page, s] = await Promise.all([listConversations(params), getStats()]);
    setConversations(page.items);
    setTotal(page.total);
    setStats(s);
  }, [filter, debouncedSearch]);

  useEffect(() => {
    setConversations(null);
    load().catch(() => {});
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => load().catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const selected = useMemo(
    () => conversations?.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  async function select(conversation: Conversation) {
    setSelectedId(conversation.id);
    if (conversation.unread) {
      await patchConversation(conversation.id, { unread: 0 }).catch(() => {});
      load().catch(() => {});
    }
  }

  const listTitle =
    filter.kind === "all"
      ? "All open"
      : filter.kind === "closed"
        ? "Closed"
        : channelMeta(filter.channel).label;

  return (
    <div className="flex h-full bg-background font-sans text-foreground">
      <Sidebar stats={stats} filter={filter} setFilter={setFilter} />

      {/* Conversation list */}
      <section className="flex w-[22rem] shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <Eyebrow>
            {listTitle} · {total}
          </Eyebrow>
        </div>
        <div className="shrink-0 border-b border-border p-3">
          <div className="flex h-9 items-center gap-2 rounded-sm border border-border bg-surface px-2.5 focus-within:border-ring">
            <Search className="size-4 shrink-0 text-faint" aria-hidden />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations…"
              aria-label="Search conversations"
              className="w-full bg-transparent text-[0.8125rem] text-foreground outline-none placeholder:text-faint"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations === null ? (
            <p className="pt-12 text-center text-sm text-muted">Loading…</p>
          ) : conversations.length === 0 ? (
            <div className="px-6 pt-12 text-center">
              <p className="text-sm text-muted">
                {debouncedSearch
                  ? "Nothing matches that search."
                  : filter.kind === "closed"
                    ? "No closed conversations yet."
                    : "No conversations yet. Ask your agent to mirror its channels into this inbox — see agent.md."}
              </p>
            </div>
          ) : (
            conversations.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                active={c.id === selectedId}
                onClick={() => select(c)}
              />
            ))
          )}
        </div>
      </section>

      {/* Thread */}
      {selected ? (
        <ThreadPane conversation={selected} onConversationChanged={() => load().catch(() => {})} />
      ) : (
        <section className="flex min-w-0 flex-1 items-center justify-center bg-background">
          <div className="text-center">
            <Inbox className="mx-auto size-6 text-faint" aria-hidden />
            <p className="mt-3 text-sm text-muted">Select a conversation to read the thread.</p>
          </div>
        </section>
      )}
    </div>
  );
}
