# real-chat

Realtime chat app built with **Next.js (App Router) + Socket.IO**.

Pick a name, join, and chat instantly — with online users, typing indicators, join/leave notices, and last 100 messages of history.

## Stack

- Next.js 16 + React 19 + TypeScript
- Tailwind CSS 4
- Socket.IO 4 (custom `server.js`)
- Time tracked with Hackatime (`project: real-chat`)

## Getting Started

```bash
cd real-chat
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — open two tabs to chat with yourself.

Production:

```bash
npm run build
npm start
# PORT=3000 by default, override with PORT=3456 npm start
```

## How it works

- `server.js` — custom Next server (`node server.js` per Next docs) + `socket.io` server. Keeps in-memory `users` map and `history` (max 100).
- `src/lib/chat-types.ts` — shared `ChatMessage`, `TypingPayload` types.
- `src/app/page.tsx` — client chat UI (`socket.io-client`): join form, message list, online sidebar, typing indicator.

Socket events:

- client → server: `join(username)`, `chat:message {text}`, `typing(bool)`
- server → client: `messages:history`, `chat:message`, `chat:system`, `users:update`, `typing {user, isTyping}`

## Project layout

```
server.js
src/
  app/
    page.tsx      # chat UI
    layout.tsx
    globals.css
  lib/
    chat-types.ts
```
