"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  BlockedProfile,
  ChatMessage,
  DmHistory,
  TypingPayload,
} from "@/lib/chat-types";
import { QUICK_REACTIONS, TTL_CHOICES } from "@/lib/chat-types";
import {
  ACCENTS,
  MODES,
  applyTheme,
  loadTheme,
  type Theme,
  type ThemeMode,
} from "@/lib/theme";
import CallPanel from "@/components/call-panel";

interface Profile {
  id?: string;
  sid?: string;
  name: string;
  email: string;
  picture?: string;
}

interface Presence {
  sid: string;
  name: string;
  status: "online" | "away";
  lastSeenAt: number;
}

function lastSeenText(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return "active now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

interface GifResult {
  id: string;
  title: string;
  url: string;
  preview: string;
}

interface SearchResult {
  id: string;
  room: string;
  user: string;
  text: string;
  at: number;
}

function highlight(text: string, query: string) {
  const words = query.split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return text;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
  return parts.map((part, i) =>
    words.some((w) => part.toLowerCase() === w.toLowerCase()) ? (
      <mark key={i} className="rounded bg-amber-200 dark:bg-amber-800">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

// Built-in sticker pack — works with empty .env, no API key needed.
const STICKERS = [
  "😂", "😍", "🔥", "👍", "👏", "🎉",
  "😭", "😮", "🤔", "😴", "👀", "💯",
  "❤️", "🚀", "✨", "💩", "👋", "🤝",
  "😎", "🥳", "😅", "🙌", "💪", "☕",
];

export default function Home() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [selfSid, setSelfSid] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [username, setUsername] = useState("");
  const [joined, setJoined] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [users, setUsers] = useState<string[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [onlineProfiles, setOnlineProfiles] = useState<Profile[]>([]);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [pickerTab, setPickerTab] = useState<"stickers" | "gifs">("stickers");
  const [gifQuery, setGifQuery] = useState("");
  const [gifResults, setGifResults] = useState<GifResult[]>([]);
  const [gifLoading, setGifLoading] = useState(false);
  const [gifsEnabled, setGifsEnabled] = useState(true);
  const [activeRoom, setActiveRoom] = useState("global");
  const [dmRooms, setDmRooms] = useState<
    Record<string, { peer: DmHistory["peer"]; messages: ChatMessage[] }>
  >({});
  const [ttlSeconds, setTtlSeconds] = useState(0);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [replyTo, setReplyTo] = useState<{
    id: string;
    user: string;
    text: string;
  } | null>(null);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [readBy, setReadBy] = useState<Record<string, string[]>>({});
  const [nowTick, setNowTick] = useState(0);
  const readSentRef = useRef<Set<string>>(new Set());
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [notifyOn, setNotifyOn] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("rc-notify") === "1";
    } catch {
      return false;
    }
  });
  const [notifyPerm, setNotifyPerm] = useState<string>(
    typeof window !== "undefined" && "Notification" in window
      ? Notification.permission
      : "unsupported"
  );
  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  const [blockedList, setBlockedList] = useState<BlockedProfile[]>([]);
  const [reportTarget, setReportTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [reportReason, setReportReason] = useState("spam");
  const [reportedFlash, setReportedFlash] = useState(false);
  const activeRoomRef = useRef(activeRoom);
  activeRoomRef.current = activeRoom;
  const usernameRef = useRef(username);
  usernameRef.current = username;
  const notifyOnRef = useRef(notifyOn);
  notifyOnRef.current = notifyOn;

  function notify(m: ChatMessage) {
    if (!notifyOnRef.current) return;
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    const room = m.room || "global";
    const n = new Notification(`${m.user} (${room === "global" ? "global" : "DM"})`, {
      body: m.kind === "text" || m.kind === "sticker" ? m.text.slice(0, 120) : "sent an image",
      tag: m.id,
    });
    n.onclick = () => {
      window.focus();
      setActiveRoom(room);
    };
  }
  const [theme, setThemeState] = useState<Theme>({
    mode: "system",
    accent: "default",
  });
  const bottomRef = useRef<HTMLDivElement>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const initial = loadTheme();
    setThemeState(initial);
    applyTheme(initial);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(loadTheme());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function setTheme(next: Theme) {
    setThemeState(next);
    applyTheme(next);
  }

  function setMode(mode: ThemeMode) {
    setTheme({ ...theme, mode });
  }

  function setAccent(accent: string) {
    setTheme({ ...theme, accent });
  }

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        setProfile(d.user ?? null);
        setGoogleEnabled(Boolean(d.googleEnabled));
        if (d.user?.name) setUsername(d.user.name);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const s = io(process.env.NEXT_PUBLIC_SOCKET_URL || undefined);
    setSocket(s);
    s.on("connect", () => {
      setConnected(true);
      setSelfSid(s.id ?? null);
    });
    s.on("disconnect", () => {
      setConnected(false);
      setSelfSid(null);
    });
    s.on("messages:history", (h: ChatMessage[]) => setMessages(h));
    s.on("chat:message", (m: ChatMessage) => {
      const room = m.room || "global";
      if (room === "global") {
        setMessages((prev) => [...prev.slice(-99), m]);
      } else {
        setDmRooms((prev) => ({
          ...prev,
          [room]: {
            peer: prev[room]?.peer ?? { name: m.user },
            messages: [...(prev[room]?.messages ?? []).slice(-99), m],
          },
        }));
      }
      // Unread: anything outside the open room, or when the tab is hidden.
      // (Own messages never count.)
      if (
        m.user !== usernameRef.current &&
        (room !== activeRoomRef.current || document.hidden)
      ) {
        setUnread((prev) => ({ ...prev, [room]: (prev[room] ?? 0) + 1 }));
        notify(m);
      }
    });
    s.on("dm:history", ({ room, peer, messages: h }: DmHistory) => {
      setDmRooms((prev) => ({ ...prev, [room]: { peer, messages: h } }));
      setActiveRoom(room);
    });
    s.on("chat:deleted", ({ room, ids }: { room: string; ids: string[] }) => {
      const gone = new Set(ids);
      setEditingId((id) => (id && gone.has(id) ? null : id));
      if (!room || room === "global") {
        setMessages((prev) => prev.filter((m) => !gone.has(m.id)));
      } else {
        setDmRooms((prev) =>
          prev[room]
            ? {
                ...prev,
                [room]: {
                  ...prev[room],
                  messages: prev[room].messages.filter((m) => !gone.has(m.id)),
                },
              }
            : prev
        );
      }
    });
    s.on("chat:system", (text: string) =>
      setNotices((prev) => [...prev.slice(-9), text])
    );
    s.on("chat:error", (text: string) =>
      setNotices((prev) => [...prev.slice(-9), `Error: ${text}`])
    );
    s.on("users:update", (u: string[]) => setUsers(u));
    s.on(
      "moderation:state",
      ({
        blockedIds,
        blocked,
      }: {
        blockedIds: string[];
        blocked?: BlockedProfile[];
      }) => {
        setBlockedIds(blockedIds ?? []);
        if (blocked) setBlockedList(blocked);
      }
    );
    s.on("moderation:reported", () => {
      setReportTarget(null);
      setReportedFlash(true);
      setTimeout(() => setReportedFlash(false), 3000);
    });
    s.on("presence:update", (p: Presence[]) => setPresence(p));
    s.on(
      "chat:read",
      ({
        user,
        messageIds,
      }: {
        user: string;
        messageIds: string[];
        readAt: number;
        room: string;
      }) => {
        setReadBy((prev) => {
          const next = { ...prev };
          for (const id of messageIds) {
            next[id] = Array.from(new Set([...(next[id] ?? []), user]));
          }
          return next;
        });
      }
    );
    s.on("profiles:update", (p: Profile[]) => setOnlineProfiles(p));
    s.on("chat:searchResults", ({ results }: { results: SearchResult[] }) => {
      setSearchResults(results);
      setSearching(false);
    });
    s.on("chat:edited", ({ message }: { message: ChatMessage }) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === message.id ? { ...m, ...message } : m))
      );
      setDmRooms((prev) => {
        const next = { ...prev };
        for (const room of Object.keys(next)) {
          next[room] = {
            ...next[room],
            messages: next[room].messages.map((m) =>
              m.id === message.id ? { ...m, ...message } : m
            ),
          };
        }
        return next;
      });
    });
    s.on(
      "reactions:update",
      ({
        messageId,
        reactions,
      }: {
        messageId: string;
        reactions: ChatMessage["reactions"];
      }) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, reactions } : m))
        );
        setDmRooms((prev) => {
          const next = { ...prev };
          for (const room of Object.keys(next)) {
            next[room] = {
              ...next[room],
              messages: next[room].messages.map((m) =>
                m.id === messageId ? { ...m, reactions } : m
              ),
            };
          }
          return next;
        });
      }
    );
    s.on("profile:ready", (p: Profile) => {
      setProfile((prev) => ({ ...prev, ...p }));
      setUsername(p.name);
    });
    s.on("typing", ({ user, isTyping }: TypingPayload) =>
      setTypingUsers((prev) =>
        isTyping ? [...new Set([...prev, user])] : prev.filter((x) => x !== user)
      )
    );
    return () => {
      s.disconnect();
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, dmRooms, activeRoom]);

  // Clear a room's badge when opened; keep the tab title in sync.
  useEffect(() => {
    setUnread((prev) => {
      if (!prev[activeRoom]) return prev;
      const next = { ...prev };
      delete next[activeRoom];
      return next;
    });
  }, [activeRoom]);

  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);

  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) real-chat` : "real-chat";
  }, [totalUnread]);

  async function toggleNotify() {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") {
      const perm = await Notification.requestPermission();
      setNotifyPerm(perm);
      if (perm !== "granted") return;
    }
    if (Notification.permission !== "granted") return;
    setNotifyOn((on) => {
      try {
        localStorage.setItem("rc-notify", on ? "0" : "1");
      } catch {
        // ignore
      }
      return !on;
    });
  }

  // Presence heartbeat: online while tab visible, away when hidden.
  useEffect(() => {
    if (!socket || !joined) return;
    const beat = () =>
      socket.emit("presence:heartbeat", {
        status: document.hidden ? "away" : "online",
      });
    beat();
    const t = setInterval(beat, 20000);
    document.addEventListener("visibilitychange", beat);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", beat);
    };
  }, [socket, joined]);

  // "now" ticker so last-seen labels stay fresh.
  useEffect(() => {
    setNowTick(Date.now());
    const t = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // Report visible messages as read (others' messages in the open room).
  useEffect(() => {
    if (!socket || !joined || document.hidden) return;
    const list =
      activeRoom === "global"
        ? messages
        : (dmRooms[activeRoom]?.messages ?? []);
    const fresh = list
      .filter((m) => m.user !== username && !readSentRef.current.has(m.id))
      .map((m) => m.id);
    if (fresh.length === 0) return;
    fresh.forEach((id) => readSentRef.current.add(id));
    socket.emit("chat:read", { messageIds: fresh, room: activeRoom });
  }, [socket, joined, messages, dmRooms, activeRoom, username]);

  useEffect(() => {
    if (showPicker && pickerTab === "gifs" && gifResults.length === 0 && gifsEnabled) {
      searchGifs(gifQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPicker, pickerTab]);

  function join(e: React.FormEvent) {
    e.preventDefault();
    const name = username.trim().slice(0, 24);
    if (!name || !socket) return;
    setUsername(name);
    socket.emit("join", {
      name,
      email: profile?.email ?? null,
      picture: profile?.picture ?? null,
    });
    setJoined(true);
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || !socket) return;
    socket.emit("chat:message", {
      text,
      kind: "text",
      room: activeRoom,
      ttlSeconds,
      replyToId: replyTo?.id ?? null,
    });
    setInput("");
    setReplyTo(null);
    socket.emit("typing", false);
  }

  function sendSticker(emoji: string) {
    if (!socket) return;
    socket.emit("chat:message", {
      text: emoji,
      kind: "sticker",
      room: activeRoom,
      ttlSeconds,
      replyToId: replyTo?.id ?? null,
    });
    setShowPicker(false);
    setReplyTo(null);
  }

  function sendGif(gif: GifResult) {
    if (!socket) return;
    socket.emit("chat:message", {
      text: gif.title || "GIF",
      kind: "gif",
      imageUrl: gif.url,
      room: activeRoom,
      ttlSeconds,
      replyToId: replyTo?.id ?? null,
    });
    setShowPicker(false);
    setReplyTo(null);
  }

  async function sendFile(file: File) {
    if (!socket || uploading) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        setNotices((prev) => [
          ...prev.slice(-9),
          `Upload failed: ${data.error ?? res.status}`,
        ]);
        return;
      }
      socket.emit("chat:message", {
        text: file.name.slice(0, 100) || "image",
        kind: "image",
        imageUrl: data.url,
        room: activeRoom,
        ttlSeconds,
        replyToId: replyTo?.id ?? null,
      });
      setReplyTo(null);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function openDm(peerSid: string) {
    if (!socket || !peerSid || peerSid === selfSid) return;
    socket.emit("dm:open", { peerSid });
  }

  function jumpTo(id: string) {
    document
      .getElementById(`msg-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(id);
    setTimeout(() => setHighlightId((h) => (h === id ? null : h)), 1500);
  }

  function toggleReaction(messageId: string, emoji: string) {
    if (!socket) return;
    socket.emit("reaction:toggle", { messageId, emoji });
  }

  function runSearch(q: string) {
    setSearchQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!socket || q.trim().length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      socket.emit("chat:search", { query: q.trim(), room: activeRoom });
    }, 400);
  }

  function openResult(r: SearchResult) {
    if (r.room === "global") {
      setActiveRoom("global");
    } else if (!dmRooms[r.room]) {
      socket?.emit("dm:openRoom", { room: r.room });
    } else {
      setActiveRoom(r.room);
    }
    setSearchOpen(false);
    setTimeout(() => jumpTo(r.id), 700);
  }

  function saveEdit(messageId: string) {
    if (!socket) return;
    const text = draftText.trim();
    if (!text) return;
    socket.emit("chat:edit", { messageId, text });
    setEditingId(null);
  }

  function deleteMessage(messageId: string) {
    if (!socket) return;
    if (!window.confirm("Delete this message?")) return;
    socket.emit("chat:delete", { messageId });
  }

  const blockedIdSet = new Set(blockedIds);
  const blockedNames = new Set(blockedList.map((b) => b.name));

  function isHidden(m: ChatMessage): boolean {
    if (m.authorId && blockedIdSet.has(m.authorId)) return true;
    if (!m.authorId && m.user !== username && blockedNames.has(m.user)) {
      return true;
    }
    return false;
  }

  function peerIdFor(m: ChatMessage): string | null {
    if (m.authorId) return m.authorId;
    return onlineProfiles.find((p) => p.name === m.user)?.id ?? null;
  }

  function setBlockUser(id: string, blocked: boolean) {
    socket?.emit("user:block", { userId: id, blocked });
  }

  function submitReport() {
    if (!socket || !reportTarget) return;
    socket.emit("user:report", {
      userId: reportTarget.id,
      reason: reportReason,
    });
  }

  const visibleMessages = (
    activeRoom === "global"
      ? messages
      : (dmRooms[activeRoom]?.messages ?? [])
  ).filter((m) => !isHidden(m));

  async function searchGifs(q: string) {
    setGifQuery(q);
    setGifLoading(true);
    try {
      const res = await fetch(`/api/gifs?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (res.status === 503 || data.configured === false) {
        setGifsEnabled(false);
        setGifResults([]);
      } else {
        setGifsEnabled(true);
        setGifResults(data.gifs ?? []);
      }
    } catch {
      setGifResults([]);
    } finally {
      setGifLoading(false);
    }
  }

  function handleTyping(v: string) {
    setInput(v);
    if (!socket || !joined) return;
    socket.emit("typing", true);
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => socket.emit("typing", false), 1200);
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setProfile(null);
    setJoined(false);
  }

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    const name = draftName.trim().slice(0, 24);
    if (!name) return;
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    if (!res?.ok) return;
    const data = await res.json();
    setProfile(data.profile ?? null);
    setUsername(data.profile?.name ?? name);
    setEditingName(false);
    socket?.emit("join", {
      name: data.profile?.name ?? name,
      email: data.profile?.email ?? profile?.email ?? null,
      picture: data.profile?.picture ?? profile?.picture ?? null,
    });
  }

  if (!joined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 p-4 dark:bg-black">
        <form
          onSubmit={join}
          className="w-full max-w-sm rounded-2xl border border-black/10 bg-white p-6 shadow dark:border-white/10 dark:bg-zinc-900"
        >
          <h1 className="text-2xl font-bold">real-chat</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {connected ? "Connected — pick a name" : "Connecting…"}
          </p>
          {googleEnabled && !profile && (
            <a
              href="/api/auth/google"
              className="mt-4 block w-full rounded-lg border border-black/10 px-3 py-2 text-center font-medium hover:bg-zinc-100 dark:border-white/15 dark:hover:bg-zinc-800"
            >
              Sign in with Google
            </a>
          )}
          {profile?.picture && (
            <img
              src={profile.picture}
              alt=""
              className="mt-4 h-10 w-10 rounded-full"
            />
          )}
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="your name"
            className="mt-4 w-full rounded-lg border border-black/10 px-3 py-2 outline-none focus:border-black dark:border-white/15 dark:bg-zinc-800"
            maxLength={24}
          />
          <button
            type="submit"
            disabled={!connected || !username.trim()}
            className="mt-3 w-full rounded-lg accent-bg px-3 py-2 font-medium disabled:opacity-40"
          >
            Join chat
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto flex h-screen w-full max-w-4xl flex-col p-4">
      <CallPanel socket={socket} selfSid={selfSid} />
      {reportTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 dark:bg-zinc-900">
            <h2 className="text-lg font-bold">Report {reportTarget.name}</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Stored for review. Blocking also hides their messages from you.
            </p>
            <select
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
              className="mt-3 w-full rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/15 dark:bg-zinc-800"
            >
              {["spam", "harassment", "hate", "nsfw", "other"].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => {
                  submitReport();
                  setBlockUser(reportTarget.id, true);
                }}
                className="flex-1 rounded-lg bg-black px-3 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
              >
                Report + block
              </button>
              <button
                onClick={submitReport}
                className="flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/15"
              >
                Report only
              </button>
              <button
                onClick={() => setReportTarget(null)}
                className="rounded-lg px-3 py-2 text-sm underline"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {reportedFlash && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full bg-black px-4 py-2 text-sm text-white dark:bg-white dark:text-black">
          Reported. Thanks.
        </div>
      )}
      <header className="flex items-center justify-between py-2">
        <h1 className="text-xl font-bold">real-chat</h1>
        <div className="flex items-center gap-3 text-sm text-zinc-500">
          <button
            onClick={() => {
              setSearchOpen((v) => !v);
              setSearchResults([]);
              setSearchQuery("");
            }}
            title="Search this conversation"
            className="rounded-lg border border-black/10 px-2 py-1 dark:border-white/15"
          >
            🔍
          </button>
          {notifyPerm !== "unsupported" && (
            <button
              onClick={() => void toggleNotify()}
              title={
                notifyPerm === "denied"
                  ? "Notifications blocked in browser settings"
                  : notifyOn
                    ? "Mute notifications"
                    : "Notify me of new messages"
              }
              className="rounded-lg border border-black/10 px-2 py-1 dark:border-white/15"
            >
              {notifyOn ? "🔔" : "🔕"}
            </button>
          )}
          {profile && (
            <>
              {profile.picture && (
                <img src={profile.picture} alt="" className="h-6 w-6 rounded-full" />
              )}
              <span className="hidden sm:inline">{profile.email}</span>
              <button onClick={signOut} className="underline">
                Sign out
              </button>
            </>
          )}
          <span>
            <span
              className={`mr-2 inline-block h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
            />
            {username} · {users.length} online
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-4">
        <section className="flex min-w-0 flex-1 flex-col rounded-2xl border border-black/10 dark:border-white/10">
          {searchOpen && (
            <div className="border-b border-black/10 p-2 dark:border-white/10">
              <input
                value={searchQuery}
                onChange={(e) => runSearch(e.target.value)}
                placeholder={`Search ${activeRoom === "global" ? "global chat" : "this DM"}… (min 2 chars)`}
                autoFocus
                className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm outline-none dark:border-white/15 dark:bg-zinc-900"
              />
              {searching && (
                <div className="px-1 pt-1 text-xs text-zinc-400">Searching…</div>
              )}
              {!searching && searchQuery.trim().length >= 2 && (
                <div className="max-h-48 space-y-1 overflow-y-auto pt-1">
                  {searchResults.length === 0 ? (
                    <div className="px-1 text-xs text-zinc-400">No matches.</div>
                  ) : (
                    searchResults.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => openResult(r)}
                        className="block w-full truncate rounded-md px-2 py-1 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        <span className="opacity-60">
                          {r.user} · {new Date(r.at).toLocaleString()}
                          {r.room !== "global" ? " · 🔒" : ""}:{" "}
                        </span>
                        {highlight(r.text, searchQuery)}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          <div className="flex gap-2 overflow-x-auto border-b border-black/10 p-2 text-xs dark:border-white/10">
            <button
              onClick={() => setActiveRoom("global")}
              className={`rounded-full px-3 py-1 ${activeRoom === "global" ? "accent-bg" : "bg-zinc-100 dark:bg-zinc-800"}`}
            >
              Global{(unread.global ?? 0) > 0 ? ` (${unread.global})` : ""}
            </button>
            {Object.entries(dmRooms).map(([room, dm]) => (
              <button
                key={room}
                onClick={() => setActiveRoom(room)}
                className={`rounded-full px-3 py-1 ${activeRoom === room ? "accent-bg" : "bg-zinc-100 dark:bg-zinc-800"}`}
              >
                🔒 {dm.peer.name}{(unread[room] ?? 0) > 0 ? ` (${unread[room]})` : ""}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
            {activeRoom !== "global" && (
              <div className="text-center text-xs text-zinc-400">
                Private conversation with {dmRooms[activeRoom]?.peer.name} — only
                you two can see this.
              </div>
            )}
            {visibleMessages.map((m) => (
              <div
                key={m.id}
                id={`msg-${m.id}`}
                className={`group relative max-w-[80%] rounded-xl px-3 py-2 text-sm ${
                  m.user === username
                    ? "ml-auto accent-bg"
                    : "bg-zinc-100 dark:bg-zinc-800"
                } ${highlightId === m.id ? "ring-2 ring-amber-400" : ""}`}
              >
                <div className="text-xs opacity-60">
                  {m.user} · {new Date(m.at).toLocaleTimeString()}
                  {m.expiresAt ? " · 🔥 disappearing" : ""}
                  {m.editedAt ? " · (edited)" : ""}
                  {m.user === username &&
                    ((readBy[m.id] ?? []).filter((u) => u !== username).length > 0 ? (
                      <span className="text-sky-400"> ✓✓</span>
                    ) : (
                      <span> ✓</span>
                    ))}
                </div>
                {m.replyTo && (
                  <button
                    onClick={() => jumpTo(m.replyTo!.id)}
                    className="mb-1 block w-full truncate rounded-md border-l-2 border-current px-2 py-0.5 text-left text-xs opacity-70 hover:opacity-100"
                  >
                    ↩ {m.replyTo.user}: {m.replyTo.text.slice(0, 80)}
                  </button>
                )}
                {m.kind === "gif" || m.kind === "image" ? (
                  m.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={m.imageUrl}
                      alt={m.text || "image"}
                      loading="lazy"
                      className="mt-1 max-h-48 rounded-lg"
                    />
                  ) : (
                    <div className="wrap-break-word">{m.text}</div>
                  )
                ) : m.kind === "sticker" ? (
                  <div className="text-4xl leading-snug">{m.text}</div>
                ) : editingId === m.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveEdit(m.id);
                    }}
                    className="mt-1 flex gap-1"
                  >
                    <input
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                      maxLength={1000}
                      autoFocus
                      className="min-w-0 flex-1 rounded-md border border-black/20 px-2 py-1 text-sm outline-none dark:border-white/25 dark:bg-zinc-900"
                    />
                    <button
                      type="submit"
                      className="rounded-md px-2 py-1 text-xs underline"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="rounded-md px-2 py-1 text-xs underline"
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div className="wrap-break-word">{m.text}</div>
                )}
                {(m.reactions?.length ?? 0) > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {m.reactions!.map((r) => (
                      <button
                        key={r.emoji}
                        onClick={() => toggleReaction(m.id, r.emoji)}
                        title={r.users.join(", ")}
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          r.users.includes(username)
                            ? "bg-black/15 dark:bg-white/25"
                            : "bg-black/5 dark:bg-white/10"
                        }`}
                      >
                        {r.emoji} {r.count}
                      </button>
                    ))}
                  </div>
                )}
                <div className="absolute -top-3 right-2 hidden gap-0.5 rounded-full border border-black/10 bg-white p-0.5 shadow group-hover:flex dark:border-white/10 dark:bg-zinc-900">
                  <button
                    onClick={() =>
                      setReplyTo({ id: m.id, user: m.user, text: m.text })
                    }
                    title="Reply"
                    className="rounded-full px-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    ↩️
                  </button>
                  {m.user === username && m.kind !== "gif" && (
                    <button
                      onClick={() => {
                        setDraftText(m.text);
                        setEditingId(m.id);
                      }}
                      title="Edit"
                      className="rounded-full px-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      ✏️
                    </button>
                  )}
                  {m.user === username && (
                    <button
                      onClick={() => deleteMessage(m.id)}
                      title="Delete"
                      className="rounded-full px-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      🗑️
                    </button>
                  )}
                  {m.user !== username &&
                    (() => {
                      const pid = peerIdFor(m);
                      if (!pid) return null;
                      return (
                        <>
                          <button
                            onClick={() => setBlockUser(pid, true)}
                            title={`Block ${m.user}`}
                            className="rounded-full px-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          >
                            🚫
                          </button>
                          <button
                            onClick={() =>
                              setReportTarget({ id: pid, name: m.user })
                            }
                            title={`Report ${m.user}`}
                            className="rounded-full px-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          >
                            ⚠️
                          </button>
                        </>
                      );
                    })()}
                  {QUICK_REACTIONS.map((e) => (
                    <button
                      key={e}
                      onClick={() => toggleReaction(m.id, e)}
                      className="rounded-full px-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {notices.map((n, i) => (
              <div key={i} className="text-center text-xs text-zinc-400">
                {n}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {typingUsers.length > 0 && (
            <div className="px-4 text-xs text-zinc-400">
              {typingUsers.join(", ")} typing…
            </div>
          )}

          {replyTo && (
            <div className="flex items-center gap-2 border-t border-black/10 px-3 py-1.5 text-xs text-zinc-500 dark:border-white/10">
              <span className="min-w-0 flex-1 truncate">
                ↩ Replying to {replyTo.user}: {replyTo.text.slice(0, 100)}
              </span>
              <button
                onClick={() => setReplyTo(null)}
                className="rounded px-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                ✕
              </button>
            </div>
          )}

          <form
            onSubmit={send}
            className="flex gap-2 border-t border-black/10 p-3 dark:border-white/10"
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void sendFile(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              aria-label="Attach image"
              title="Attach image (max 5 MB)"
              className="rounded-lg border border-black/10 px-3 py-2 disabled:opacity-40 dark:border-white/15"
            >
              {uploading ? "…" : "📎"}
            </button>            <div className="relative">
              <button
                type="button"
                onClick={() => setShowPicker((v) => !v)}
                aria-label="Stickers and GIFs"
                className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/15"
              >
                😀
              </button>
              {showPicker && (
                <div className="absolute bottom-12 left-0 z-10 w-72 rounded-xl border border-black/10 bg-white p-3 shadow-lg dark:border-white/10 dark:bg-zinc-900">
                  <div className="mb-2 flex gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setPickerTab("stickers")}
                      className={`rounded px-2 py-1 ${pickerTab === "stickers" ? "accent-bg" : "bg-zinc-100 dark:bg-zinc-800"}`}
                    >
                      Stickers
                    </button>
                    <button
                      type="button"
                      onClick={() => setPickerTab("gifs")}
                      className={`rounded px-2 py-1 ${pickerTab === "gifs" ? "accent-bg" : "bg-zinc-100 dark:bg-zinc-800"}`}
                    >
                      GIFs
                    </button>
                  </div>
                  {pickerTab === "stickers" ? (
                    <div className="grid max-h-48 grid-cols-6 gap-1 overflow-y-auto">
                      {STICKERS.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => sendSticker(s)}
                          className="rounded p-1 text-2xl hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  ) : gifsEnabled ? (
                    <div>
                      <div className="mb-2 flex gap-1">
                        <input
                          value={gifQuery}
                          onChange={(e) => searchGifs(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.preventDefault();
                          }}
                          placeholder="Search GIFs…"
                          className="min-w-0 flex-1 rounded-md border border-black/10 px-2 py-1 text-xs outline-none dark:border-white/15 dark:bg-zinc-800"
                        />
                      </div>
                      <div className="grid max-h-48 grid-cols-3 gap-1 overflow-y-auto">
                        {gifLoading && (
                          <div className="col-span-3 text-center text-xs text-zinc-400">
                            Loading…
                          </div>
                        )}
                        {!gifLoading && gifResults.length === 0 && (
                          <div className="col-span-3 text-center text-xs text-zinc-400">
                            No GIFs found.
                          </div>
                        )}
                        {gifResults.map((g) => (
                          <button key={g.id} type="button" onClick={() => sendGif(g)}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={g.preview || g.url}
                              alt={g.title}
                              loading="lazy"
                              className="h-16 w-full rounded object-cover"
                            />
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-zinc-500">
                      GIF search needs a key — add{" "}
                      <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
                        GIPHY_API_KEY
                      </code>{" "}
                      to <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">.env</code>.
                      Stickers above work without any key.
                    </div>
                  )}
                </div>
              )}
            </div>
            <input
              value={input}
              onChange={(e) => handleTyping(e.target.value)}
              placeholder={
                activeRoom === "global"
                  ? "Type a message…"
                  : "Private message…"
              }
              maxLength={1000}
              className="min-w-0 flex-1 rounded-lg border border-black/10 px-3 py-2 outline-none focus:border-black dark:border-white/15 dark:bg-zinc-900"
            />
            <select
              value={ttlSeconds}
              onChange={(e) => setTtlSeconds(Number(e.target.value))}
              title="Disappearing messages"
              className="rounded-lg border border-black/10 bg-transparent px-2 py-2 text-sm dark:border-white/15"
            >
              {TTL_CHOICES.map((t) => (
                <option key={t.seconds} value={t.seconds}>
                  {t.seconds === 0 ? "🔒 Keep" : `🔥 ${t.label}`}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-lg accent-bg px-4 py-2 font-medium"
            >
              Send
            </button>
          </form>
        </section>

        <aside className="hidden w-52 shrink-0 rounded-2xl border border-black/10 p-3 text-sm dark:border-white/10 sm:block">
          <div className="font-semibold">My profile</div>
          <div className="mt-2 flex items-center gap-2">
            {profile?.picture ? (
              <img src={profile.picture} alt="" className="h-8 w-8 rounded-full" />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-200 text-xs font-bold dark:bg-zinc-700">
                {(username || "?").slice(0, 1).toUpperCase()}
              </span>
            )}
            <div className="min-w-0">
              <div className="truncate font-medium">{username}</div>
              <div className="truncate text-xs text-zinc-400">
                {profile?.email || "guest"}
              </div>
            </div>
          </div>
          {editingName ? (
            <form onSubmit={saveName} className="mt-2 flex gap-1">
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                maxLength={24}
                placeholder="New name"
                className="min-w-0 flex-1 rounded-md border border-black/10 px-2 py-1 text-xs outline-none dark:border-white/15 dark:bg-zinc-900"
              />
              <button type="submit" className="rounded-md accent-bg px-2 py-1 text-xs">
                Save
              </button>
            </form>
          ) : (
            <button
              onClick={() => {
                setDraftName(username);
                setEditingName(true);
              }}
              className="mt-2 text-xs underline"
            >
              Rename
            </button>
          )}
          <div className="mt-4 font-semibold">Theme</div>
          <div className="mt-2 flex gap-1">
            {MODES.map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 rounded-md px-2 py-1 text-xs capitalize ${theme.mode === m ? "accent-bg" : "bg-zinc-100 dark:bg-zinc-800"}`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-6 gap-1">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                title={a.label}
                onClick={() => setAccent(a.id)}
                style={{ background: a.swatch }}
                className={`h-6 rounded-full ${theme.accent === a.id ? "ring-2 ring-offset-2 ring-zinc-400 dark:ring-zinc-500 dark:ring-offset-zinc-900" : ""}`}
              />
            ))}
          </div>
          <div className="mt-4 font-semibold">
            Online ({onlineProfiles.length || users.length})
          </div>
          <p className="text-xs text-zinc-400">Click a name for a private chat.</p>
          <ul className="mt-2 space-y-1">
            {(onlineProfiles.length > 0
              ? onlineProfiles.filter(
                  (u) =>
                    !(u.id && blockedIdSet.has(u.id)) &&
                    !(u.name !== username && blockedNames.has(u.name))
                )
              : users
                  .filter((n) => n !== username && !blockedNames.has(n))
                  .map((u) => ({ name: u }) as Profile))
              .map((u) => {
                const p =
                  presence.find((x) => u.sid && x.sid === u.sid) ??
                  presence.find((x) => x.name === u.name);
                const away = !p || p.status === "away";
                return (
                <li
                  key={`${u.id ?? u.name}-${u.email ?? ""}`}
                  className="flex items-center gap-2 truncate text-zinc-600 dark:text-zinc-300"
                >
                  <button
                    onClick={() => u.sid && openDm(u.sid)}
                    title={u.sid ? `Private chat with ${u.name}` : u.name}
                    className="flex min-w-0 flex-1 items-center gap-2 truncate rounded px-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <span
                      title={p ? lastSeenText(p.lastSeenAt, nowTick) : "offline"}
                      className={`h-2 w-2 shrink-0 rounded-full ${away ? "bg-amber-400" : "bg-green-500"}`}
                    />
                    {u.picture && (
                      <img src={u.picture} alt="" className="h-5 w-5 rounded-full" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{u.name}</span>
                  </button>
                  {u.sid && u.sid !== selfSid && (
                    <span className="flex gap-1">
                      <button
                        title={`Voice call ${u.name}`}
                        onClick={() =>
                          window.dispatchEvent(
                            new CustomEvent("rc:call-invite", {
                              detail: { sid: u.sid, name: u.name, kind: "audio" },
                            })
                          )
                        }
                        className="rounded px-1 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                      >
                        📞
                      </button>
                      <button
                        title={`Video call ${u.name}`}
                        onClick={() =>
                          window.dispatchEvent(
                            new CustomEvent("rc:call-invite", {
                              detail: { sid: u.sid, name: u.name, kind: "video" },
                            })
                          )
                        }
                        className="rounded px-1 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                      >
                        🎥
                      </button>
                    </span>
                  )}
                </li>
                );
              })}
          </ul>
          {blockedList.length > 0 && (
            <>
              <div className="mt-4 font-semibold">
                Blocked ({blockedList.length})
              </div>
              <ul className="mt-2 space-y-1">
                {blockedList.map((b) => (
                  <li
                    key={b.id}
                    className="flex items-center gap-2 text-zinc-400"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {b.name}
                    </span>
                    <button
                      onClick={() => setBlockUser(b.id, false)}
                      className="text-xs underline"
                    >
                      Unblock
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>
    </main>
  );
}
