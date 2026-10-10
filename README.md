# real-chat

Realtime chat app built with **Next.js (App Router) + Socket.IO**.

Find your online partner, have endless chat and fun, use countless stickers and GIFs, join a group to multiply the craze. Make vibes you never had!

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
src/
  app/
    api/
      auth/       # Google Authorization
        callback/
          google/
            route.ts
        google/
          route.ts
        logout/
          route.ts
        me/
          route.ts
      files/
        [...key]/
          route.ts
      gifs/       # GIFs
        route.ts
      health/
        route.ts
      profile/
        route.ts
      rtc-config/
        route.ts
      uploads/
        route.ts
    globals.css
    layout.tsx
    page.tsx      # chat UI
  components/
    call-panel.tsx
    sw-register.tsx
  lib/
    auth.ts
    chat-types.ts
    s3.ts
    theme.ts
  server/
    database.js
    server.js
.env
.env.example
```