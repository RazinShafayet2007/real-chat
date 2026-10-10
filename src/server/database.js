import { randomUUID } from "crypto";
import { neon } from "@neondatabase/serverless";

// Neon HTTP driver (SQL over HTTPS) instead of node-postgres: the pg wire
// protocol stalls from some sandboxed networks, while HTTPS always works.
// Falls back to ephemeral in-memory storage when DATABASE_URL is unset.
/** @type {import("@neondatabase/serverless").NeonQueryFunction<any, any> | undefined} */
let sql;
let memoryFallback = false;
/** @type {Array<{id: string, user: string, text: string, at: number, kind?: string, imageUrl?: string, room?: string, expiresAt?: number | null, replyToId?: string | null, editedAt?: number | null, authorId?: string | null}>} */
const memoryMessages = [];
/** @type {Map<string, {id: string, name: string, email: string | null, picture: string | null}>} */
const memoryProfiles = new Map();
/** "bm25" | "tsrank" | null (null = memory/uninitialized). */
let searchMode = null;
/** @type {Map<string, Map<string, {userId: string, username: string, emoji: string}>>} */
const memoryReactions = new Map();
/** @type {Map<string, Set<string>>} blockerId -> blockedIds */
const memoryBlocks = new Map();
/** @type {Array<{id: string, reporterId: string, reportedId: string, reason: string, at: number}>} */
const memoryReports = [];

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

/** True when queries actually hit Postgres (false = ephemeral memory). */
export function isDatabaseLive() {
  return !memoryFallback && Boolean(sql);
}

// Network-level failures: boot degraded instead of crashing, so local
// dev/sandboxes without a DB route still run. Auth/config errors throw.
const NETWORK_ERRORS = new Set([
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

function isNetworkError(error) {
  if (!error) return false;
  if (NETWORK_ERRORS.has(error.code)) return true;
  const msg = String(error.message || "");
  return (
    msg.includes("fetch failed") ||
    msg.includes("Failed to fetch") ||
    msg.includes("timeout")
  );
}

function degradeToMemory(reason) {
  console.warn(
    `> Database unreachable (${reason}) — using in-memory message history`
  );
  memoryFallback = true;
  sql = undefined;
  memoryMessages.length = 0;
  memoryReactions.clear();
  memoryBlocks.clear();
  memoryReports.length = 0;
}

/**
 * Run a live query, degrading to the memory fallback (once) when the
 * network drops mid-run. Auth/config errors still throw.
 */
async function liveQuery(reason, live, fallback) {
  if (memoryFallback || !sql) return fallback();
  try {
    return await live(sql);
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    degradeToMemory(`${reason}: ${error.code || error.message}`);
    return fallback();
  }
}

export async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    // .env is intentionally empty for now — run with ephemeral in-memory
    // history so `npm run dev` works until a real DATABASE_URL is provided.
    memoryFallback = true;
    memoryMessages.length = 0;
    console.log("> No DATABASE_URL set — using in-memory message history");
    return;
  }

  sql = neon(process.env.DATABASE_URL);

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        kind TEXT NOT NULL DEFAULT 'text',
        image_url TEXT,
        room TEXT NOT NULL DEFAULT 'global',
        expires_at TIMESTAMPTZ
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS chat_messages_created_at_idx
      ON chat_messages (created_at DESC)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS chat_messages_room_created_at_idx
      ON chat_messages (room, created_at DESC)
    `;
    // Migrate databases created before sticker/GIF support.
    await sql`
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text'
    `;
    await sql`
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS image_url TEXT
    `;
    // Migrate databases created before private/disappearing chats.
    await sql`
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS room TEXT NOT NULL DEFAULT 'global'
    `;
    await sql`
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
    `;
    // Replies: parent deleted -> reply stays, quote goes null.
    await sql`
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to_id TEXT REFERENCES chat_messages (id) ON DELETE SET NULL
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS chat_messages_reply_to_idx
      ON chat_messages (reply_to_id)
    `;
    // Edit history: edited_at marks updated messages.
    await sql`
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ
    `;
    // Moderation: author id for per-user content filtering.
    await sql`
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS author_id TEXT
    `;
    // Full-text search: stored tsvector + BM25 (lakebase_text) with
    // plain ts_rank/GIN fallback when the extension is unavailable.
    try {
      await sql`CREATE EXTENSION IF NOT EXISTS lakebase_text`;
      await sql`
        ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS content_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS chat_messages_content_bm25 ON chat_messages
        USING lakebase_bm25 (content_tsv) WITH (k1 = 1.2, b = 0.75)
      `;
      searchMode = "bm25";
    } catch (error) {
      console.warn(
        "> lakebase_text unavailable, full-text falls back to ts_rank:",
        error.code || error.message
      );
      await sql`
        ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS content_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS chat_messages_content_tsv_idx
        ON chat_messages USING GIN (content_tsv)
      `;
      searchMode = "tsrank";
    }
    await sql`
      CREATE TABLE IF NOT EXISTS chat_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        picture TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS message_reactions (
        message_id TEXT NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (message_id, user_id, emoji)
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS message_reactions_message_idx
      ON message_reactions (message_id)
    `;
    // Basic moderation: blocks hide content client-side + bar DMs/calls;
    // reports are stored for later review.
    await sql`
      CREATE TABLE IF NOT EXISTS user_blocks (
        blocker_id TEXT NOT NULL,
        blocked_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (blocker_id, blocked_id)
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS user_reports (
        id TEXT PRIMARY KEY,
        reporter_id TEXT NOT NULL,
        reported_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  } catch (error) {
    sql = undefined;
    if (isNetworkError(error)) {
      degradeToMemory(error.code || error.message);
      return;
    }
    throw error;
  }
}

export async function closeDatabase() {
  if (memoryFallback) {
    memoryFallback = false;
    memoryMessages.length = 0;
    memoryProfiles.clear();
    memoryReactions.clear();
    memoryBlocks.clear();
    memoryReports.length = 0;
    return;
  }
  sql = undefined;
}

/**
 * @param {number} limit
 * @param {string} [room]
 */
export async function getRecentMessages(limit, room = "global") {
  const now = Date.now();
  const fromMemory = () => {
    const messages = memoryMessages
      .filter(
        (m) =>
          (m.room || "global") === room &&
          (m.expiresAt == null || m.expiresAt > now)
      )
      .slice(-limit);
    const byId = new Map(memoryMessages.map((m) => [m.id, m]));
    return attachReactions(
      withReplyTo(messages, (id) => byId.get(id)),
      aggregateReactions(
        messages.flatMap((m) =>
          Array.from((memoryReactions.get(m.id) ?? new Map()).values()).map(
            (r) => ({ message_id: m.id, username: r.username, emoji: r.emoji })
          )
        )
      )
    );
  };
  return liveQuery("history", async (db) => {
    const rows = await db`
      SELECT m.id, m.username, m.content, m.created_at, m.kind, m.image_url,
             m.room, m.expires_at, m.reply_to_id, m.edited_at, m.author_id,
             p.username AS parent_user, p.content AS parent_text
      FROM chat_messages m
      LEFT JOIN chat_messages p ON p.id = m.reply_to_id
      WHERE m.room = ${room} AND (m.expires_at IS NULL OR m.expires_at > NOW())
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${limit}
    `;

    const messages = rows.reverse().map((row) => ({
      id: row.id,
      user: row.username,
      text: row.content,
      at: new Date(row.created_at).getTime(),
      kind: row.kind === "gif" || row.kind === "sticker" || row.kind === "image" ? row.kind : "text",
      imageUrl: row.image_url || undefined,
      room: row.room,
      expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
      replyToId: row.reply_to_id || null,
      replyTo: row.reply_to_id
        ? { id: row.reply_to_id, user: row.parent_user, text: row.parent_text }
        : null,
      editedAt: row.edited_at ? new Date(row.edited_at).getTime() : null,
      authorId: row.author_id || null,
    }));
    if (messages.length === 0) return messages;
    const reactionRows = await db`
      SELECT message_id, username, emoji FROM message_reactions
      WHERE message_id = ANY(${messages.map((m) => m.id)})
    `;
    return attachReactions(messages, aggregateReactions(reactionRows));
  }, fromMemory);
}

export async function saveMessage(message) {
  const kind =
    message.kind === "gif" || message.kind === "sticker" || message.kind === "image" ? message.kind : "text";
  const imageUrl =
    typeof message.imageUrl === "string" ? message.imageUrl.slice(0, 2048) : null;
  const room =
    typeof message.room === "string" && message.room.length <= 128
      ? message.room
      : "global";
  const expiresAt =
    typeof message.expiresAt === "number" && message.expiresAt > Date.now()
      ? message.expiresAt
      : null;
  const replyToId =
    typeof message.replyToId === "string" && message.replyToId.length <= 128
      ? message.replyToId
      : null;
  const authorId =
    typeof message.authorId === "string" && message.authorId.length <= 128
      ? message.authorId
      : null;
  const storeMemory = () => {
    memoryMessages.push({
      ...message,
      kind,
      imageUrl: imageUrl || undefined,
      room,
      expiresAt,
      replyToId,
      authorId,
    });
    while (memoryMessages.length > 500) memoryMessages.shift();
  };
  return liveQuery("save", async (db) => {
    const createdAt = new Date(message.at).toISOString();
    await db`
      INSERT INTO chat_messages (id, username, content, created_at, kind, image_url, room, expires_at, reply_to_id, author_id)
      VALUES (${message.id}, ${message.user}, ${message.text}, ${createdAt}, ${kind}, ${imageUrl}, ${room}, ${expiresAt ? new Date(expiresAt).toISOString() : null}, ${replyToId}, ${authorId})
    `;
  }, storeMemory);
}

/** Edit own message text. Returns updated message or null (not found / not owner). */
export async function editMessage({ messageId, username, text }) {
  const clean = String(text ?? "").slice(0, 1000).trim();
  if (!messageId || !clean) throw new Error("Invalid edit");
  const editedAt = Date.now();

  const fromMemory = () => {
    const msg = memoryMessages.find((m) => m.id === messageId);
    if (!msg || msg.user !== username) return null;
    msg.text = clean;
    msg.editedAt = editedAt;
    return { ...msg };
  };

  return liveQuery("edit", async (db) => {
    const rows = await db`
      UPDATE chat_messages
      SET content = ${clean}, edited_at = ${new Date(editedAt).toISOString()}
      WHERE id = ${messageId} AND username = ${username}
      RETURNING id, username, content, created_at, kind, image_url, room,
                expires_at, reply_to_id, edited_at, author_id
    `;
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      user: r.username,
      text: r.content,
      at: new Date(r.created_at).getTime(),
      kind: r.kind === "gif" || r.kind === "sticker" || r.kind === "image" ? r.kind : "text",
      imageUrl: r.image_url || undefined,
      room: r.room,
      expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
      replyToId: r.reply_to_id || null,
      replyTo: null,
      editedAt,
      authorId: r.author_id || null,
    };
  }, fromMemory);
}

/** Delete own message. Returns { id, room } or null (not found / not owner). */
export async function deleteMessage({ messageId, username }) {
  const fromMemory = () => {
    const idx = memoryMessages.findIndex((m) => m.id === messageId);
    if (idx === -1 || memoryMessages[idx].user !== username) return null;
    const [msg] = memoryMessages.splice(idx, 1);
    memoryReactions.delete(messageId);
    return { id: messageId, room: msg.room || "global" };
  };

  return liveQuery("delete", async (db) => {
    const rows = await db`
      DELETE FROM chat_messages
      WHERE id = ${messageId} AND username = ${username}
      RETURNING id, room
    `;
    if (rows.length === 0) return null;
    return { id: rows[0].id, room: rows[0].room || "global" };
  }, fromMemory);
}
/** Delete expired disappearing messages. Returns [{ id, room }]. */
export async function purgeExpiredMessages() {
  const now = Date.now();
  const fromMemory = () => {
    const expired = memoryMessages.filter(
      (m) => m.expiresAt != null && m.expiresAt <= now
    );
    if (expired.length === 0) return [];
    const ids = new Set(expired.map((m) => m.id));
    for (let i = memoryMessages.length - 1; i >= 0; i--) {
      if (ids.has(memoryMessages[i].id)) memoryMessages.splice(i, 1);
    }
    for (const id of ids) memoryReactions.delete(id);
    return expired.map((m) => ({ id: m.id, room: m.room || "global" }));
  };
  return liveQuery("purge", async (db) => {
    const rows = await db`
      DELETE FROM chat_messages
      WHERE expires_at IS NOT NULL AND expires_at <= NOW()
      RETURNING id, room
    `;
    return rows.map((r) => ({ id: r.id, room: r.room }));
  }, fromMemory);
}

function aggregateReactions(rows) {
  const byMessage = new Map();
  for (const r of rows) {
    if (!byMessage.has(r.message_id)) byMessage.set(r.message_id, new Map());
    const byEmoji = byMessage.get(r.message_id);
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push(r.username);
  }
  const out = new Map();
  for (const [messageId, byEmoji] of byMessage) {
    out.set(
      messageId,
      Array.from(byEmoji.entries()).map(([emoji, users]) => ({
        emoji,
        count: users.length,
        users,
      }))
    );
  }
  return out;
}

function withReplyTo(messages, lookup) {
  return messages.map((m) => {
    if (!m.replyToId) return { ...m, replyTo: null };
    const parent = lookup(m.replyToId);
    return {
      ...m,
      replyTo: parent
        ? {
            id: parent.id,
            user: parent.user ?? parent.username,
            text: parent.text ?? parent.content,
          }
        : null,
    };
  });
}

function attachReactions(messages, byMessage) {
  return messages.map((m) => ({ ...m, reactions: byMessage.get(m.id) ?? [] }));
}

/**
 * Toggle one reaction. Returns { room, reactions } for broadcast,
 * or null when the message doesn't exist.
 */
export async function toggleReaction({ messageId, userId, username, emoji }) {
  const cleanEmoji = String(emoji || "").slice(0, 16);
  if (!messageId || !cleanEmoji) throw new Error("Invalid reaction");

  const fromMemory = () => {
    const idx = memoryMessages.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;
    const msg = memoryMessages[idx];
    if (!memoryReactions.has(messageId)) {
      memoryReactions.set(messageId, new Map());
    }
    const bucket = memoryReactions.get(messageId);
    const key = `${userId}:${cleanEmoji}`;
    if (bucket.has(key)) bucket.delete(key);
    else bucket.set(key, { userId, username, emoji: cleanEmoji });
    return {
      room: msg.room || "global",
      reactions: aggregateReactions(
        Array.from(bucket.values()).map((r) => ({
          message_id: messageId,
          username: r.username,
          emoji: r.emoji,
        }))
      ).get(messageId) ?? [],
    };
  };

  return liveQuery("reactions", async (db) => {
    const msgs = await db`SELECT id, room FROM chat_messages WHERE id = ${messageId} LIMIT 1`;
    if (msgs.length === 0) return null;
    const room = msgs[0].room || "global";
    const existing = await db`
      SELECT 1 FROM message_reactions
      WHERE message_id = ${messageId} AND user_id = ${userId} AND emoji = ${cleanEmoji}
      LIMIT 1
    `;
    if (existing.length > 0) {
      await db`
        DELETE FROM message_reactions
        WHERE message_id = ${messageId} AND user_id = ${userId} AND emoji = ${cleanEmoji}
      `;
    } else {
      await db`
        INSERT INTO message_reactions (message_id, user_id, username, emoji)
        VALUES (${messageId}, ${userId}, ${username}, ${cleanEmoji})
        ON CONFLICT DO NOTHING
      `;
    }
    const rows = await db`
      SELECT message_id, username, emoji FROM message_reactions
      WHERE message_id = ${messageId}
    `;
    return {
      room,
      reactions: aggregateReactions(rows).get(messageId) ?? [],
    };
  }, fromMemory);
}

/** Room of a message (for access checks + targeted broadcast). */
export async function getMessageRoom(messageId) {
  const msg = await getMessage(messageId);
  return msg ? msg.room : null;
}

/** Full message header for reply validation. */
export async function getMessage(messageId) {
  const fromMemory = () => {
    const m = memoryMessages.find((m) => m.id === messageId);
    if (!m) return null;
    if (m.expiresAt != null && m.expiresAt <= Date.now()) return null;
    return {
      id: m.id,
      room: m.room || "global",
      user: m.user,
      text: m.text,
    };
  };
  return liveQuery("message", async (db) => {
    const rows = await db`
      SELECT id, room, username, content FROM chat_messages
      WHERE id = ${messageId}
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    const r = rows[0];
    return { id: r.id, room: r.room || "global", user: r.username, text: r.content };
  }, fromMemory);
}

/**
 * Full-text search inside one room. Returns newest-first matches with
 * a plain-text excerpt (client highlights, so no HTML ever ships).
 */
export async function searchMessages({ query, room, limit = 20 }) {
  const q = String(query ?? "").trim().slice(0, 100);
  if (!q) return [];

  const fromMemory = () => {
    const needle = q.toLowerCase();
    const now = Date.now();
    return memoryMessages
      .filter(
        (m) =>
          (m.room || "global") === room &&
          (m.expiresAt == null || m.expiresAt > now) &&
          m.text.toLowerCase().includes(needle)
      )
      .slice(-100)
      .reverse()
      .slice(0, limit)
      .map((m) => ({
        id: m.id,
        room: m.room || "global",
        user: m.user,
        text: m.text.slice(0, 300),
        at: m.at,
      }));
  };

  return liveQuery("search", async (db) => {
    if (searchMode === "bm25") {
      const rows = await db`
        SELECT id, room, username, content, created_at,
               content_tsv <@> to_bm25query(
                 to_tsvector('english', ${q}),
                 'chat_messages_content_bm25'::regclass
               ) AS score
        FROM chat_messages
        WHERE room = ${room}
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY score
        LIMIT ${limit}
      `;
      return rows.map((r) => ({
        id: r.id,
        room: r.room,
        user: r.username,
        text: String(r.content).slice(0, 300),
        at: new Date(r.created_at).getTime(),
      }));
    }
    const rows = await db`
      SELECT id, room, username, content, created_at
      FROM chat_messages
      WHERE room = ${room}
        AND (expires_at IS NULL OR expires_at > NOW())
        AND content_tsv @@ plainto_tsquery('english', ${q})
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      room: r.room,
      user: r.username,
      text: String(r.content).slice(0, 300),
      at: new Date(r.created_at).getTime(),
    }));
  }, fromMemory);
}

/** Profile by id (for opening DM rooms with offline peers). */
export async function getProfileById(id) {
  const fromMemory = () => {
    for (const p of memoryProfiles.values()) {
      if (p.id === id) return { ...p };
    }
    return null;
  };
  return liveQuery("profile", async (db) => {
    const rows = await db`
      SELECT id, name, email, picture FROM chat_users WHERE id = ${id} LIMIT 1
    `;
    return rows.length > 0 ? toProfile(rows[0]) : null;
  }, fromMemory);
}

function profileKey(name, email) {
  if (email) return `email:${email.toLowerCase()}`;
  return `guest:${String(name).toLowerCase()}`;
}

function toProfile(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    picture: row.picture,
  };
}

/**
 * Create or refresh a user profile. Guests are keyed by name,
 * Google users are keyed by email.
 * @param {{name: string, email?: string | null, picture?: string | null}} input
 */
export async function upsertUser({ name, email = null, picture = null }) {
  const cleanName = String(name || "anon").slice(0, 24) || "anon";
  const cleanEmail = email ? String(email).slice(0, 320) : null;
  const cleanPicture = picture ? String(picture).slice(0, 2048) : null;

  const fromMemory = () => {
    const key = profileKey(cleanName, cleanEmail);
    const existing = memoryProfiles.get(key);
    if (existing) {
      existing.name = cleanName;
      if (cleanPicture) existing.picture = cleanPicture;
      return { ...existing };
    }
    const profile = {
      id: randomUUID(),
      name: cleanName,
      email: cleanEmail,
      picture: cleanPicture,
    };
    memoryProfiles.set(key, profile);
    return { ...profile };
  };

  return liveQuery("users", async (db) => {
    if (cleanEmail) {
      const rows = await db`
        INSERT INTO chat_users (id, name, email, picture)
        VALUES (${randomUUID()}, ${cleanName}, ${cleanEmail}, ${cleanPicture})
        ON CONFLICT (email) DO UPDATE SET
          name = EXCLUDED.name,
          picture = COALESCE(EXCLUDED.picture, chat_users.picture),
          last_seen = NOW()
        RETURNING id, name, email, picture
      `;
      return toProfile(rows[0]);
    }

    const found = await db`
      SELECT id, name, email, picture FROM chat_users
      WHERE email IS NULL AND LOWER(name) = LOWER(${cleanName})
      ORDER BY last_seen DESC LIMIT 1
    `;
    if (found.length > 0) {
      const row = found[0];
      await db`UPDATE chat_users SET last_seen = NOW() WHERE id = ${row.id}`;
      return toProfile(row);
    }
    const rows = await db`
      INSERT INTO chat_users (id, name, email, picture)
      VALUES (${randomUUID()}, ${cleanName}, NULL, NULL)
      RETURNING id, name, email, picture
    `;
    return toProfile(rows[0]);
  }, fromMemory);
}

/**
 * @param {string} id
 * @param {string} name
 */
export async function renameUser(id, name) {
  const cleanName = String(name || "").slice(0, 24).trim();
  if (!cleanName) throw new Error("Name is required");
  const fromMemory = () => {
    for (const profile of memoryProfiles.values()) {
      if (profile.id === id) {
        const oldKey = profileKey(profile.name, profile.email);
        profile.name = cleanName;
        if (!profile.email) {
          memoryProfiles.delete(oldKey);
          memoryProfiles.set(profileKey(cleanName, null), profile);
        }
        return { ...profile };
      }
    }
    throw new Error("Profile not found");
  };
  return liveQuery("rename", async (db) => {
    const rows = await db`
      UPDATE chat_users SET name = ${cleanName}, last_seen = NOW()
      WHERE id = ${id} RETURNING id, name, email, picture
    `;
    if (rows.length === 0) throw new Error("Profile not found");
    return toProfile(rows[0]);
  }, fromMemory);
}

/**
 * Block / unblock by profile id. Returns the blocker's blocked-id list.
 * Self-block is rejected.
 */
export async function setBlock({ blockerId, blockedId, blocked }) {
  if (!blockerId || !blockedId || blockerId === blockedId) {
    throw new Error("Invalid block");
  }

  const fromMemory = () => {
    if (!memoryBlocks.has(blockerId)) memoryBlocks.set(blockerId, new Set());
    const set = memoryBlocks.get(blockerId);
    if (blocked) set.add(blockedId);
    else set.delete(blockedId);
    return Array.from(set);
  };

  return liveQuery("blocks", async (db) => {
    if (blocked) {
      await db`
        INSERT INTO user_blocks (blocker_id, blocked_id)
        VALUES (${blockerId}, ${blockedId})
        ON CONFLICT DO NOTHING
      `;
    } else {
      await db`
        DELETE FROM user_blocks
        WHERE blocker_id = ${blockerId} AND blocked_id = ${blockedId}
      `;
    }
    const rows = await db`
      SELECT blocked_id FROM user_blocks WHERE blocker_id = ${blockerId}
    `;
    return rows.map((r) => r.blocked_id);
  }, fromMemory);
}

/** Blocked-id list for one profile (for per-client filtering). */
export async function getBlockedIds(blockerId) {
  const fromMemory = () =>
    Array.from(memoryBlocks.get(blockerId) ?? new Set());
  return liveQuery("blocks", async (db) => {
    const rows = await db`
      SELECT blocked_id FROM user_blocks WHERE blocker_id = ${blockerId}
    `;
    return rows.map((r) => r.blocked_id);
  }, fromMemory);
}

/** Blocked profiles with names (so clients can filter legacy messages). */
export async function getBlockedProfiles(blockerId) {
  const ids = await getBlockedIds(blockerId);
  if (ids.length === 0) return [];
  const fromMemory = () =>
    ids
      .map((id) => {
        for (const p of memoryProfiles.values()) {
          if (p.id === id) return { id: p.id, name: p.name };
        }
        return null;
      })
      .filter(Boolean);
  return liveQuery("blocks", async (db) => {
    const rows = await db`
      SELECT u.id, u.name FROM chat_users u
      JOIN user_blocks b ON b.blocked_id = u.id
      WHERE b.blocker_id = ${blockerId}
    `;
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }, fromMemory);
}

/** True when either profile blocked the other (DM/call barrier). */
export async function isBlockedEither(idA, idB) {
  const fromMemory = () =>
    (memoryBlocks.get(idA)?.has(idB) ?? false) ||
    (memoryBlocks.get(idB)?.has(idA) ?? false);
  return liveQuery("blocks", async (db) => {
    const rows = await db`
      SELECT 1 FROM user_blocks
      WHERE (blocker_id = ${idA} AND blocked_id = ${idB})
         OR (blocker_id = ${idB} AND blocked_id = ${idA})
      LIMIT 1
    `;
    return rows.length > 0;
  }, fromMemory);
}

const REPORT_REASONS = new Set(["spam", "harassment", "hate", "nsfw", "other"]);

/** Store a moderation report. Returns { id }. */
export async function reportUser({ reporterId, reportedId, reason }) {
  const cleanReason = REPORT_REASONS.has(reason) ? reason : "other";
  if (!reporterId || !reportedId || reporterId === reportedId) {
    throw new Error("Invalid report");
  }

  const fromMemory = () => {
    const report = {
      id: randomUUID(),
      reporterId,
      reportedId,
      reason: cleanReason,
      at: Date.now(),
    };
    memoryReports.push(report);
    return { id: report.id };
  };

  return liveQuery("reports", async (db) => {
    const id = randomUUID();
    await db`
      INSERT INTO user_reports (id, reporter_id, reported_id, reason)
      VALUES (${id}, ${reporterId}, ${reportedId}, ${cleanReason})
    `;
    return { id };
  }, fromMemory);
}
