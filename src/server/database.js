import { Pool } from "pg";
import { randomUUID } from "crypto";

let pool;
let memoryFallback = false;
/** @type {Array<{id: string, user: string, text: string, at: number, kind?: string, imageUrl?: string, room?: string, expiresAt?: number | null}>} */
const memoryMessages = [];
/** @type {Map<string, {id: string, name: string, email: string | null, picture: string | null}>} */
const memoryProfiles = new Map();

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
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

  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on("error", (error) => {
    console.error("Unexpected PostgreSQL pool error:", error);
  });

  try {
    await pool.query(`
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
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS chat_messages_created_at_idx
      ON chat_messages (created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS chat_messages_room_created_at_idx
      ON chat_messages (room, created_at DESC)
    `);
    // Migrate databases created before sticker/GIF support.
    await pool.query(`
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text'
    `);
    await pool.query(`
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS image_url TEXT
    `);
    // Migrate databases created before private/disappearing chats.
    await pool.query(`
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS room TEXT NOT NULL DEFAULT 'global'
    `);
    await pool.query(`
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        picture TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (error) {
    await pool.end();
    pool = undefined;
    throw error;
  }
}

export async function closeDatabase() {
  if (memoryFallback) {
    memoryFallback = false;
    memoryMessages.length = 0;
    memoryProfiles.clear();
    return;
  }
  if (!pool) return;
  await pool.end();
  pool = undefined;
}

/**
 * @param {number} limit
 * @param {string} [room]
 */
export async function getRecentMessages(limit, room = "global") {
  const now = Date.now();
  if (memoryFallback || !pool) {
    return memoryMessages
      .filter(
        (m) =>
          (m.room || "global") === room &&
          (m.expiresAt == null || m.expiresAt > now)
      )
      .slice(-limit);
  }
  const { rows } = await pool.query(
    `SELECT id, username, content, created_at, kind, image_url, room, expires_at
     FROM chat_messages
     WHERE room = $2 AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC, id DESC
     LIMIT $1`,
    [limit, room]
  );

  return rows.reverse().map((row) => ({
    id: row.id,
    user: row.username,
    text: row.content,
    at: new Date(row.created_at).getTime(),
    kind: row.kind === "gif" || row.kind === "sticker" ? row.kind : "text",
    imageUrl: row.image_url || undefined,
    room: row.room,
    expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
  }));
}

export async function saveMessage(message) {
  const kind =
    message.kind === "gif" || message.kind === "sticker" ? message.kind : "text";
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
  if (memoryFallback || !pool) {
    memoryMessages.push({
      ...message,
      kind,
      imageUrl: imageUrl || undefined,
      room,
      expiresAt,
    });
    while (memoryMessages.length > 500) memoryMessages.shift();
    return;
  }
  await pool.query(
    `INSERT INTO chat_messages (id, username, content, created_at, kind, image_url, room, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      message.id,
      message.user,
      message.text,
      new Date(message.at),
      kind,
      imageUrl,
      room,
      expiresAt ? new Date(expiresAt) : null,
    ]
  );
}

/** Delete expired disappearing messages. Returns [{ id, room }]. */
export async function purgeExpiredMessages() {
  const now = Date.now();
  if (memoryFallback || !pool) {
    const expired = memoryMessages.filter(
      (m) => m.expiresAt != null && m.expiresAt <= now
    );
    if (expired.length === 0) return [];
    const ids = new Set(expired.map((m) => m.id));
    for (let i = memoryMessages.length - 1; i >= 0; i--) {
      if (ids.has(memoryMessages[i].id)) memoryMessages.splice(i, 1);
    }
    return expired.map((m) => ({ id: m.id, room: m.room || "global" }));
  }
  const { rows } = await pool.query(
    `DELETE FROM chat_messages
      WHERE expires_at IS NOT NULL AND expires_at <= NOW()
      RETURNING id, room`
  );
  return rows.map((r) => ({ id: r.id, room: r.room }));
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

  if (memoryFallback || !pool) {
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
  }

  if (cleanEmail) {
    const { rows } = await pool.query(
      `INSERT INTO chat_users (id, name, email, picture)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name,
         picture = COALESCE(EXCLUDED.picture, chat_users.picture),
         last_seen = NOW()
       RETURNING id, name, email, picture`,
      [randomUUID(), cleanName, cleanEmail, cleanPicture]
    );
    return toProfile(rows[0]);
  }

  const found = await pool.query(
    `SELECT id, name, email, picture FROM chat_users
      WHERE email IS NULL AND LOWER(name) = LOWER($1)
      ORDER BY last_seen DESC LIMIT 1`,
    [cleanName]
  );
  if (found.rows.length > 0) {
    const row = found.rows[0];
    await pool.query(
      `UPDATE chat_users SET last_seen = NOW() WHERE id = $1`,
      [row.id]
    );
    return toProfile(row);
  }
  const { rows } = await pool.query(
    `INSERT INTO chat_users (id, name, email, picture)
     VALUES ($1, $2, NULL, NULL) RETURNING id, name, email, picture`,
    [randomUUID(), cleanName]
  );
  return toProfile(rows[0]);
}

/**
 * @param {string} id
 * @param {string} name
 */
export async function renameUser(id, name) {
  const cleanName = String(name || "").slice(0, 24).trim();
  if (!cleanName) throw new Error("Name is required");
  if (memoryFallback || !pool) {
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
  }
  const { rows } = await pool.query(
    `UPDATE chat_users SET name = $2, last_seen = NOW()
      WHERE id = $1 RETURNING id, name, email, picture`,
    [id, cleanName]
  );
  if (rows.length === 0) throw new Error("Profile not found");
  return toProfile(rows[0]);
}
