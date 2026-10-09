import { createServer } from "http";
import { randomUUID } from "crypto";
import pkg from "@next/env";
const { loadEnvConfig } = pkg;
import next from "next";
import { Server } from "socket.io";
import {
  closeDatabase,
  getRecentMessages,
  initializeDatabase,
  purgeExpiredMessages,
  saveMessage,
  upsertUser,
} from "./database.js";

loadEnvConfig(process.cwd());
const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev }); // Next.js development server
const handle = app.getRequestHandler();

const users = new Map(); // socket.id -> { id, name, email, picture }
const MAX_HISTORY = 100; // Users can see the last 100 messages

const TTL_OPTIONS = new Set([0, 10, 60, 3600, 86400]);

/** DM room for two profile ids (order-independent). */
function dmRoomFor(idA, idB) {
  return `dm:${[idA, idB].sort().join(":")}`;
}

/** Only global or a DM room containing your own profile id. */
function canAccessRoom(profileId, room) {
  if (room === "global") return true;
  if (typeof room !== "string" || !room.startsWith("dm:")) return false;
  return room.split(":").slice(1).includes(profileId);
}

// `broadcastUsers` sends the current list of users to every client connected
// through `io`. It gets the user records from the `users` map with `users.values()`
// and convert them into an array with `Array.from()`, then emits that array as the
// payload of the `users:update` event.

function broadcastUsers(io) {
  const profiles = Array.from(users.entries()).map(([sid, p]) => ({
    ...p,
    sid,
  }));
  io.emit(
    "users:update",
    profiles.map((p) => p.name)
  );
  io.emit("profiles:update", profiles);
}

// Relay a signaling/call event to one connected peer only.
// Returns true when delivered, false when the peer is gone.
function relay(io, socket, toSid, event, payload) {
  if (typeof toSid !== "string" || !io.sockets.sockets.get(toSid)) {
    socket.emit("call:error", "Peer is no longer online.");
    return false;
  }
  io.to(toSid).emit(event, { ...payload, from: socket.id });
  return true;
}

// Initialization of Server

async function startServer() {
  await app.prepare();
  await initializeDatabase();

  const httpServer = createServer((req, res) => {
    handle(req, res);
  });

  const io = new Server(httpServer, {
    cors: { 
      origin: process.env.CLIENT_ORIGIN || "http://localhost:3000",
    },
  });

  io.on("connection", (socket) => {
    socket.join("global");
    getRecentMessages(MAX_HISTORY)
      .then((history) => socket.emit("messages:history", history))
      .catch((error) => {
        console.error("Failed to load message history:", error);
        socket.emit(
          "chat:error",
          "Could not load message history. Please try again later."
        );
      });

    socket.on("join", async (payload) => {
      const input =
        typeof payload === "string" ? { name: payload } : payload ?? {};
      try {
        const profile = await upsertUser({
          name: input.name || "anon",
          email: input.email || null,
          picture: input.picture || null,
        });
        users.set(socket.id, profile);
        socket.emit("profile:ready", profile);
      } catch (error) {
        console.error("Failed to upsert user profile:", error);
        const name =
          String(input.name || "anon").slice(0, 24) || "anon";
        users.set(socket.id, { id: socket.id, name, email: null, picture: null });
      }
      broadcastUsers(io);
      const joined = users.get(socket.id);
      socket.broadcast.emit("chat:system", `${joined.name} joined`);
    });

    socket.on("chat:message", async (payload) => {
      const profile = users.get(socket.id);
      const user = profile?.name || "anon";
      const kind =
        payload?.kind === "gif" || payload?.kind === "sticker"
          ? payload.kind
          : "text";
      const text = String(payload?.text ?? "").slice(0, 1000).trim();
      const room =
        typeof payload?.room === "string" && payload.room
          ? payload.room
          : "global";
      if (!profile || !canAccessRoom(profile.id, room)) {
        socket.emit("chat:error", "You are not in this conversation.");
        return;
      }
      const ttlSeconds = TTL_OPTIONS.has(payload?.ttlSeconds)
        ? payload.ttlSeconds
        : 0;
      let imageUrl;
      if (kind === "gif") {
        const raw = String(payload?.imageUrl ?? "").slice(0, 2048);
        // Only allow remote https artwork (e.g. Giphy) — never inline data.
        if (!/^https:\/\//.test(raw)) {
          socket.emit("chat:error", "GIF must be an https image URL.");
          return;
        }
        imageUrl = raw;
      }
      if (!text && !imageUrl) return;
      const msg = {
        id: randomUUID(),
        user,
        text,
        at: Date.now(),
        kind,
        imageUrl,
        room,
        expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
      };
      try {
        await saveMessage(msg);
        if (room === "global") {
          io.emit("chat:message", msg);
        } else {
          io.to(room).emit("chat:message", msg);
        }
      } catch (error) {
        console.error("Failed to save chat message:", error);
        socket.emit(
          "chat:error",
          "Message could not be saved. Please try again."
        );
      }
    });

    // Open (or create) a 1:1 DM room with an online peer.
    socket.on("dm:open", async ({ peerSid } = {}) => {
      const me = users.get(socket.id);
      const peer = typeof peerSid === "string" ? users.get(peerSid) : null;
      if (!me || !peer) {
        socket.emit("chat:error", "Peer is no longer online.");
        return;
      }
      const room = dmRoomFor(me.id, peer.id);
      socket.join(room);
      try {
        const history = await getRecentMessages(MAX_HISTORY, room);
        socket.emit("dm:history", { room, peer: { ...peer }, messages: history });
        // Make sure the peer also joins so they receive new messages live.
        const peerSocket = io.sockets.sockets.get(peerSid);
        peerSocket?.join(room);
      } catch (error) {
        console.error("Failed to load DM history:", error);
        socket.emit("chat:error", "Could not open conversation.");
      }
    });

    socket.on("typing", (isTyping) => {
      const profile = users.get(socket.id);
      const user = profile?.name;
      if (!user) return;
      socket.broadcast.emit("typing", { user, isTyping: !!isTyping });
    });

    // --- Voice/video call signaling (WebRTC P2P, server only relays) ---
    socket.on("call:invite", ({ toSid, kind } = {}) => {
      const from = users.get(socket.id);
      relay(io, socket, toSid, "call:invite", {
        kind: kind === "video" ? "video" : "audio",
        fromName: from?.name || "anon",
      });
    });
    socket.on("call:accept", ({ toSid } = {}) => {
      relay(io, socket, toSid, "call:accept", {});
    });
    socket.on("call:reject", ({ toSid } = {}) => {
      relay(io, socket, toSid, "call:reject", {});
    });
    socket.on("call:end", ({ toSid } = {}) => {
      relay(io, socket, toSid, "call:end", {});
    });
    socket.on("webrtc:signal", ({ toSid, data } = {}) => {
      if (!data) return;
      relay(io, socket, toSid, "webrtc:signal", { data });
    });

    socket.on("disconnect", () => {
      const profile = users.get(socket.id);
      const name = profile?.name;
      users.delete(socket.id);
      broadcastUsers(io);
      if (name) socket.broadcast.emit("chat:system", `${name} left`);
      // Tell the other side if we vanish mid-call.
      socket.broadcast.emit("call:end", { from: socket.id });
    });
  });

  // Disappearing messages: sweep every 15s and tell each room what's gone.
  setInterval(async () => {
    try {
      const gone = await purgeExpiredMessages();
      if (gone.length === 0) return;
      const byRoom = new Map();
      for (const { id, room } of gone) {
        if (!byRoom.has(room)) byRoom.set(room, []);
        byRoom.get(room).push(id);
      }
      for (const [room, ids] of byRoom) {
        if (room === "global") io.emit("chat:deleted", { room, ids });
        else io.to(room).emit("chat:deleted", { room, ids });
      }
    } catch (error) {
      console.error("Failed to purge expired messages:", error);
    }
  }, 15000).unref?.();

  httpServer.listen(port, () => {
    console.log(
      `> Server listening at http://localhost:${port} as ${
        dev ? "development" : process.env.NODE_ENV
      }`
    );
  });
}

// Catch errors
startServer().catch((error) => {
  console.error("Failed to start chat server:", error);
  closeDatabase()
    .catch((closeError) => {
      console.error("Failed to close PostgreSQL connection pool:", closeError);
    })
    .finally(() => {
      process.exitCode = 1;
    });
});
