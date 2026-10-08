# real-chat

Realtime chat app built with **Next.js (App Router) + Socket.IO**.

Pick a name, join, and chat instantly — with online users, typing indicators, join/leave notices, and last 100 messages of history.

The app currently supports anonymous chat with persistent message history.

## Stack

- Next.js 16 + React 19 + TypeScript
- Tailwind CSS 4
- Socket.IO 4 (custom `src/server/server.js`)
- Time tracked with Hackatime (`project: real-chat`)

## Getting Started

```bash
cd real-chat
npm install
npm run dev
```

Copy `.env.example` to `.env.local`, then set `DATABASE_URL` to your PostgreSQL
connection string (for example, from Neon). The server creates the messages
table and index when it starts. Never commit real credentials; configure them
as environment variables in your production hosting provider.

Open [http://localhost:3000](http://localhost:3000) — open two tabs to chat with yourself.

Production:

```bash
npm run build
npm start
# PORT=3000 by default, override with PORT=3456 npm start
```

## How it works

- `src/server/server.js` — custom Next server + `socket.io` server. Keeps online users in memory and loads/saves the latest chat messages in PostgreSQL.
- `src/server/database.js` — PostgreSQL connection, startup schema setup, and message queries.
- `src/lib/chat-types.ts` — shared `ChatMessage`, `TypingPayload` types.
- `src/app/page.tsx` — client chat UI (`socket.io-client`): join form, message list, online sidebar, typing indicator.

Socket events:

- client → server: `join(username)`, `chat:message {text}`, `typing(bool)`
- server → client: `messages:history`, `chat:message`, `chat:system`, `users:update`, `typing {user, isTyping}`

## Project layout

```
.env.example
src/
  app/
    page.tsx      # chat UI
    layout.tsx
    globals.css
  lib/
    chat-types.ts
  server/
    server.js
```

## Future Works
[] Integrating Google OAuth
[] Creating real user profile
[x] Integrate real database
[] Sticker and GIF support
[] Video and Audio call support

## Future Description

Find your online partner, have endless chat and fun, use countless stickers and GIFs, join a group to multiply the craze.