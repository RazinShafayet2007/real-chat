"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { ChatMessage, TypingPayload } from "@/lib/chat-types";

export default function Home() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [username, setUsername] = useState("");
  const [joined, setJoined] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [users, setUsers] = useState<string[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const s = io(process.env.NEXT_PUBLIC_SOCKET_URL || undefined);
    setSocket(s);
    s.on("connect", () => setConnected(true));
    s.on("disconnect", () => setConnected(false));
    s.on("messages:history", (h: ChatMessage[]) => setMessages(h));
    s.on("chat:message", (m: ChatMessage) =>
      setMessages((prev) => [...prev.slice(-99), m])
    );
    s.on("chat:system", (text: string) =>
      setNotices((prev) => [...prev.slice(-9), text])
    );
    s.on("chat:error", (text: string) =>
      setNotices((prev) => [...prev.slice(-9), `Error: ${text}`])
    );
    s.on("users:update", (u: string[]) => setUsers(u));
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
  }, [messages]);

  function join(e: React.FormEvent) {
    e.preventDefault();
    const name = username.trim().slice(0, 24);
    if (!name || !socket) return;
    setUsername(name);
    socket.emit("join", name);
    setJoined(true);
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || !socket) return;
    socket.emit("chat:message", { text });
    setInput("");
    socket.emit("typing", false);
  }

  function handleTyping(v: string) {
    setInput(v);
    if (!socket || !joined) return;
    socket.emit("typing", true);
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => socket.emit("typing", false), 1200);
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
            className="mt-3 w-full rounded-lg bg-black px-3 py-2 font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
          >
            Join chat
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto flex h-screen w-full max-w-4xl flex-col p-4">
      <header className="flex items-center justify-between py-2">
        <h1 className="text-xl font-bold">real-chat</h1>
        <div className="text-sm text-zinc-500">
          <span
            className={`mr-2 inline-block h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
          />
          {username} · {users.length} online
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-4">
        <section className="flex min-w-0 flex-1 flex-col rounded-2xl border border-black/10 dark:border-white/10">
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${
                  m.user === username
                    ? "ml-auto bg-black text-white dark:bg-white dark:text-black"
                    : "bg-zinc-100 dark:bg-zinc-800"
                }`}
              >
                <div className="text-xs opacity-60">
                  {m.user} · {new Date(m.at).toLocaleTimeString()}
                </div>
                <div className="wrap-break-word">{m.text}</div>
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
          >
            <input
              value={input}
              onChange={(e) => handleTyping(e.target.value)}
              placeholder="Type a message…"
              maxLength={1000}
              className="min-w-0 flex-1 rounded-lg border border-black/10 px-3 py-2 outline-none focus:border-black dark:border-white/15 dark:bg-zinc-900"
            />
            <button
              type="submit"
              className="rounded-lg bg-black px-4 py-2 font-medium text-white dark:bg-white dark:text-black"
            >
              Send
            </button>
          </form>
        </section>

        <aside className="hidden w-44 shrink-0 rounded-2xl border border-black/10 p-3 text-sm dark:border-white/10 sm:block">
          <div className="font-semibold">Online</div>
          <ul className="mt-2 space-y-1">
            {users.map((u) => (
              <li key={u} className="truncate text-zinc-600 dark:text-zinc-300">
                ● {u}
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </main>
  );
}
