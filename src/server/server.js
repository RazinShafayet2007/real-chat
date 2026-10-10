import { createServer } from "http";
import { randomUUID } from "crypto";
import pkg from "@next/env";
const { loadEnvConfig } = pkg;
import next from "next";
import { Server } from "socket.io";
import {
  closeDatabase,
  deleteMessage,
  editMessage,
  getBlockedIds,
  getBlockedProfiles,
  getMessage,
  getMessageRoom,
  getProfileById,
  getRecentMessages,
  initializeDatabase,
  isBlockedEither,
  purgeExpiredMessages,
  reportUser,
  saveMessage,
  searchMessages,
  setBlock,
  toggleReaction,
  upsertUser,
} from "./database.js";

loadEnvConfig(process.cwd());
const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev }); // Next.js development server
const handle = app.getRequestHandler();

const users = new Map(); // socket.id -> { id, name, email, picture, status, lastSeenAt }
const MAX_HISTORY = 100; // Users can see the last 100 messages

const AWAY_AFTER_MS = 45000;
const PRESENCE_SWEEP_MS = 15000;

function touch(socketId, status) {
  const p = users.get(socketId);
  if (!p) return;
  p.lastSeenAt = Date.now();
  if (status === "online" || status === "away") p.status = status;
}

function presenceList() {
  const now = Date.now();
  return Array.from(users.entries()).map(([sid, p]) => ({
    sid,
    name: p.name,
    status:
      p.status === "away" || now - (p.lastSeenAt || now) > AWAY_AFTER_MS
        ? "away"
        : "online",
    lastSeenAt: p.lastSeenAt || now,
  }));
}

function broadcastPresence(io) {
  io.emit("presence:update", presenceList());
}

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
        users.set(socket.id, {
          ...profile,
          status: "online",
          lastSeenAt: Date.now(),
        });
        socket.emit("profile:ready", profile);
      } catch (error) {
        console.error("Failed to upsert user profile:", error);
        const name =
          String(input.name || "anon").slice(0, 24) || "anon";
        users.set(socket.id, {
          id: socket.id,
          name,
          email: null,
          picture: null,
          status: "online",
          lastSeenAt: Date.now(),
        });
      }
      broadcastUsers(io);
      broadcastPresence(io);
      try {
        const me = users.get(socket.id);
        const [blockedIds, blocked] = await Promise.all([
          getBlockedIds(me.id),
          getBlockedProfiles(me.id),
        ]);
        socket.emit("moderation:state", { blockedIds, blocked });
      } catch (error) {
        console.error("Failed to load block list:", error);
      }
      const joined = users.get(socket.id);
      socket.broadcast.emit("chat:system", `${joined.name} joined`);
    });

    // Explicit presence (tab hidden -> away). Anything else touches activity.
    socket.on("presence:heartbeat", ({ status } = {}) => {
      touch(socket.id, status === "away" ? "away" : "online");
    });

    // Read receipts: relay who saw what to the room.
    socket.on("chat:read", ({ messageIds, room } = {}) => {
      const profile = users.get(socket.id);
      const ids = Array.isArray(messageIds)
        ? messageIds.filter((id) => typeof id === "string").slice(0, 100)
        : [];
      const targetRoom = typeof room === "string" && room ? room : "global";
      if (!profile || ids.length === 0) return;
      if (!canAccessRoom(profile.id, targetRoom)) return;
      touch(socket.id);
      const payload = {
        user: profile.name,
        messageIds: ids,
        readAt: Date.now(),
        room: targetRoom,
      };
      if (targetRoom === "global") io.emit("chat:read", payload);
      else io.to(targetRoom).emit("chat:read", payload);
    });

    socket.on("chat:message", async (payload) => {
      const profile = users.get(socket.id);
      const user = profile?.name || "anon";
      const kind =
        payload?.kind === "gif" ||
        payload?.kind === "sticker" ||
        payload?.kind === "image"
          ? payload.kind
          : "text";
      const text = String(payload?.text ?? "").slice(0, 1000).trim();
      let room =
        typeof payload?.room === "string" && payload.room
          ? payload.room
          : "global";
      if (!profile || !canAccessRoom(profile.id, room)) {
        socket.emit("chat:error", "You are not in this conversation.");
        return;
      }
      // Replies inherit the parent's room so quotes can't leak across rooms.
      let replyToId = null;
      let replyTo = null;
      if (typeof payload?.replyToId === "string" && payload.replyToId) {
        const parent = await getMessage(payload.replyToId);
        if (!parent || !canAccessRoom(profile.id, parent.room)) {
          socket.emit("chat:error", "Quoted message not found.");
          return;
        }
        room = parent.room;
        replyToId = parent.id;
        replyTo = { id: parent.id, user: parent.user, text: parent.text };
      }
      const ttlSeconds = TTL_OPTIONS.has(payload?.ttlSeconds)
        ? payload.ttlSeconds
        : 0;
      let imageUrl;
      if (kind === "gif" || kind === "image") {
        const raw = String(payload?.imageUrl ?? "").slice(0, 2048);
        // Remote https artwork (e.g. Giphy) or our own /api/files/ uploads.
        // Never inline data: URLs.
        const ok =
          /^https:\/\//.test(raw) ||
          (kind === "image" && /^\/api\/files\/chat\/[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(raw));
        if (!ok) {
          socket.emit("chat:error", "Image must be an https or uploaded URL.");
          return;
        }
        imageUrl = raw;
      }
      if (!text && !imageUrl) return;
      touch(socket.id);
      const msg = {
        id: randomUUID(),
        user,
        authorId: profile.id,
        text,
        at: Date.now(),
        kind,
        imageUrl,
        room,
        expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
        replyToId,
        replyTo,
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
      if (await isBlockedEither(me.id, peer.id)) {
        socket.emit("chat:error", "Conversation unavailable.");
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

    // Open a DM room by id (for search results; peer may be offline).
    socket.on("dm:openRoom", async ({ room } = {}) => {
      const me = users.get(socket.id);
      if (!me || typeof room !== "string") return;
      if (!canAccessRoom(me.id, room) || room === "global") return;
      const peerId = room
        .split(":")
        .slice(1)
        .find((id) => id !== me.id);
      if (peerId && (await isBlockedEither(me.id, peerId))) {
        socket.emit("chat:error", "Conversation unavailable.");
        return;
      }
      const peer = peerId ? await getProfileById(peerId) : null;
      socket.join(room);
      try {
        const history = await getRecentMessages(MAX_HISTORY, room);
        socket.emit("dm:history", {
          room,
          peer: peer ?? { name: "private chat" },
          messages: history,
        });
      } catch (error) {
        console.error("Failed to open DM room:", error);
        socket.emit("chat:error", "Could not open conversation.");
      }
    });

    // Full-text search inside one accessible room.
    socket.on("chat:search", async ({ query, room } = {}) => {
      const profile = users.get(socket.id);
      const targetRoom = typeof room === "string" && room ? room : "global";
      if (!profile || !canAccessRoom(profile.id, targetRoom)) return;
      try {
        const results = await searchMessages({
          query,
          room: targetRoom,
          limit: 20,
        });
        socket.emit("chat:searchResults", { room: targetRoom, results });
      } catch (error) {
        console.error("Search failed:", error);
      }
    });

    socket.on("typing", (isTyping) => {
      const profile = users.get(socket.id);
      const user = profile?.name;
      if (!user) return;
      touch(socket.id);
      socket.broadcast.emit("typing", { user, isTyping: !!isTyping });
    });

    // Edit own message text (owner-checked by username).
    socket.on("chat:edit", async ({ messageId, text } = {}) => {
      const profile = users.get(socket.id);
      if (!profile) return;
      try {
        const updated = await editMessage({
          messageId,
          username: profile.name,
          text,
        });
        if (!updated) {
          socket.emit("chat:error", "Could not edit message.");
          return;
        }
        if (!canAccessRoom(profile.id, updated.room || "global")) return;
        const payload = { message: updated };
        if ((updated.room || "global") === "global") io.emit("chat:edited", payload);
        else io.to(updated.room).emit("chat:edited", payload);
      } catch (error) {
        console.error("Failed to edit message:", error);
        socket.emit("chat:error", "Could not edit message.");
      }
    });

    // Delete own message (replies keep a null quote, reactions cascade).
    socket.on("chat:delete", async ({ messageId } = {}) => {
      const profile = users.get(socket.id);
      if (!profile) return;
      try {
        const deleted = await deleteMessage({
          messageId,
          username: profile.name,
        });
        if (!deleted) {
          socket.emit("chat:error", "Could not delete message.");
          return;
        }
        if (!canAccessRoom(profile.id, deleted.room)) return;
        const payload = { room: deleted.room, ids: [deleted.id] };
        if (deleted.room === "global") io.emit("chat:deleted", payload);
        else io.to(deleted.room).emit("chat:deleted", payload);
      } catch (error) {
        console.error("Failed to delete message:", error);
        socket.emit("chat:error", "Could not delete message.");
      }
    });

    // Toggle an emoji reaction (tap again to remove).
    socket.on("reaction:toggle", async ({ messageId, emoji } = {}) => {
      const profile = users.get(socket.id);
      if (!profile) return;
      try {
        const room = await getMessageRoom(messageId);
        if (!room || !canAccessRoom(profile.id, room)) return;
        const result = await toggleReaction({
          messageId,
          userId: profile.id,
          username: profile.name,
          emoji,
        });
        if (!result) return;
        const payload = { messageId, reactions: result.reactions };
        if (result.room === "global") io.emit("reactions:update", payload);
        else io.to(result.room).emit("reactions:update", payload);
      } catch (error) {
        console.error("Failed to toggle reaction:", error);
      }
    });

    // Block / unblock by profile id. Returns the fresh block list
    // so the client can filter content immediately.
    socket.on("user:block", async ({ userId, blocked } = {}) => {
      const me = users.get(socket.id);
      if (!me || typeof userId !== "string") return;
      try {
        await setBlock({
          blockerId: me.id,
          blockedId: userId,
          blocked: blocked !== false,
        });
        const [blockedIds, blockedProfiles] = await Promise.all([
          getBlockedIds(me.id),
          getBlockedProfiles(me.id),
        ]);
        socket.emit("moderation:state", {
          blockedIds,
          blocked: blockedProfiles,
        });
      } catch (error) {
        console.error("Failed to update block:", error);
      }
    });

    // Report a profile id for later review.
    socket.on("user:report", async ({ userId, reason } = {}) => {
      const me = users.get(socket.id);
      if (!me || typeof userId !== "string") return;
      try {
        await reportUser({
          reporterId: me.id,
          reportedId: userId,
          reason,
        });
        socket.emit("moderation:reported", {});
      } catch (error) {
        console.error("Failed to store report:", error);
      }
    });

    // --- Voice/video call signaling (WebRTC P2P, server only relays) ---
    socket.on("call:invite", async ({ toSid, kind } = {}) => {
      const from = users.get(socket.id);
      const peer = typeof toSid === "string" ? users.get(toSid) : null;
      if (from && peer && (await isBlockedEither(from.id, peer.id))) {
        socket.emit("call:error", "Call unavailable.");
        return;
      }
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
      broadcastPresence(io);
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

  // Presence sweep: recompute online/away so stale clients fade out.
  setInterval(() => {
    if (users.size > 0) broadcastPresence(io);
  }, PRESENCE_SWEEP_MS).unref?.();

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
