"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { ChatMessage, DmHistory, TypingPayload } from "@/lib/chat-types";
import { TTL_CHOICES } from "@/lib/chat-types";
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

interface GifResult {
  id: string;
  title: string;
  url: string;
  preview: string;
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
    });
    s.on("dm:history", ({ room, peer, messages: h }: DmHistory) => {
      setDmRooms((prev) => ({ ...prev, [room]: { peer, messages: h } }));
      setActiveRoom(room);
    });
    s.on("chat:deleted", ({ room, ids }: { room: string; ids: string[] }) => {
      const gone = new Set(ids);
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
    s.on("profiles:update", (p: Profile[]) => setOnlineProfiles(p));
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
    });
    setInput("");
    socket.emit("typing", false);
  }

  function sendSticker(emoji: string) {
    if (!socket) return;
    socket.emit("chat:message", {
      text: emoji,
      kind: "sticker",
      room: activeRoom,
      ttlSeconds,
    });
    setShowPicker(false);
  }

  function sendGif(gif: GifResult) {
    if (!socket) return;
    socket.emit("chat:message", {
      text: gif.title || "GIF",
      kind: "gif",
      imageUrl: gif.url,
      room: activeRoom,
      ttlSeconds,
    });
    setShowPicker(false);
  }

  function openDm(peerSid: string) {
    if (!socket || !peerSid || peerSid === selfSid) return;
    socket.emit("dm:open", { peerSid });
  }

  const visibleMessages =
    activeRoom === "global"
      ? messages
      : (dmRooms[activeRoom]?.messages ?? []);

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
      <header className="flex items-center justify-between py-2">
        <h1 className="text-xl font-bold">real-chat</h1>
        <div className="flex items-center gap-3 text-sm text-zinc-500">
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
          <div className="flex gap-2 overflow-x-auto border-b border-black/10 p-2 text-xs dark:border-white/10">
            <button
              onClick={() => setActiveRoom("global")}
              className={`rounded-full px-3 py-1 ${activeRoom === "global" ? "accent-bg" : "bg-zinc-100 dark:bg-zinc-800"}`}
            >
              Global
            </button>
            {Object.entries(dmRooms).map(([room, dm]) => (
              <button
                key={room}
                onClick={() => setActiveRoom(room)}
                className={`rounded-full px-3 py-1 ${activeRoom === room ? "accent-bg" : "bg-zinc-100 dark:bg-zinc-800"}`}
              >
                🔒 {dm.peer.name}
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
                className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${
                  m.user === username
                    ? "ml-auto accent-bg"
                    : "bg-zinc-100 dark:bg-zinc-800"
                }`}
              >
                <div className="text-xs opacity-60">
                  {m.user} · {new Date(m.at).toLocaleTimeString()}
                  {m.expiresAt ? " · 🔥 disappearing" : ""}
                </div>
                {m.kind === "gif" && m.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={m.imageUrl}
                    alt={m.text || "GIF"}
                    loading="lazy"
                    className="mt-1 max-h-48 rounded-lg"
                  />
                ) : m.kind === "sticker" ? (
                  <div className="text-4xl leading-snug">{m.text}</div>
                ) : (
                  <div className="wrap-break-word">{m.text}</div>
                )}
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

          <form
            onSubmit={send}
            className="flex gap-2 border-t border-black/10 p-3 dark:border-white/10"
          >            <div className="relative">
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
              ? onlineProfiles
              : users.map((u) => ({ name: u }) as Profile))
              .map((u) => (
                <li
                  key={`${u.id ?? u.name}-${u.email ?? ""}`}
                  className="flex items-center gap-2 truncate text-zinc-600 dark:text-zinc-300"
                >
                  <button
                    onClick={() => u.sid && openDm(u.sid)}
                    title={u.sid ? `Private chat with ${u.name}` : u.name}
                    className="flex min-w-0 flex-1 items-center gap-2 truncate rounded px-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    {u.picture ? (
                      <img src={u.picture} alt="" className="h-5 w-5 rounded-full" />
                    ) : (
                      <span>●</span>
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
              ))}
          </ul>
        </aside>
      </div>
    </main>
  );
}
