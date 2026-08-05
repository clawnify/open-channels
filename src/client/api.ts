/** Typed client for the open-channels API — plain fetch against /api/*. */

export interface Contact {
  id: string;
  channel: string;
  handle: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface Conversation {
  id: string;
  channel: string;
  subject: string | null;
  status: string;
  unread: number;
  lastMessageAt: string;
  lastMessagePreview: string;
  contact: Contact;
}

export interface Message {
  id: string;
  conversationId: string;
  kind: string; // inbound | outbound | system | comment
  body: string;
  authorName: string | null;
  status: string | null; // queued | sent | failed (outbound only)
  error: string | null;
  createdAt: string;
}

export interface Stats {
  totalOpen: number;
  totalUnread: number;
  queued: number;
  channels: { channel: string; open: number }[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init?.headers } : init?.headers,
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export function listConversations(params: {
  channel?: string;
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: Conversation[]; total: number }> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  return request(`/api/conversations?${q}`);
}

export const getStats = (): Promise<Stats> => request("/api/stats");

export const getMessages = (
  conversationId: string,
  limit = 100,
): Promise<{ items: Message[]; hasMore: boolean }> =>
  request(`/api/conversations/${conversationId}/messages?limit=${limit}`);

export const sendReply = (conversationId: string, body: string): Promise<Message> =>
  request(`/api/conversations/${conversationId}/reply`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });

export const addComment = (conversationId: string, body: string): Promise<Message> =>
  request(`/api/conversations/${conversationId}/comment`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });

export const patchConversation = (
  conversationId: string,
  patch: { status?: "open" | "closed"; unread?: 0 },
): Promise<{ ok: boolean }> =>
  request(`/api/conversations/${conversationId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
