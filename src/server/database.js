import { Pool } from "pg";

let pool;

export async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to start the chat server.");
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
        created_at TIMESTAMPTZ NOT NULL
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS chat_messages_created_at_idx
      ON chat_messages (created_at DESC)
    `);
  } catch (error) {
    await pool.end();
    pool = undefined;
    throw error;
  }
}

export async function closeDatabase() {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}

export async function getRecentMessages(limit) {
  const { rows } = await pool.query(
    `SELECT id, username, content, created_at
     FROM chat_messages
     ORDER BY created_at DESC, id DESC
     LIMIT $1`,
    [limit]
  );

  return rows.reverse().map((row) => ({
    id: row.id,
    user: row.username,
    text: row.content,
    at: new Date(row.created_at).getTime(),
  }));
}

export async function saveMessage(message) {
  await pool.query(
    `INSERT INTO chat_messages (id, username, content, created_at)
     VALUES ($1, $2, $3, $4)`,
    [message.id, message.user, message.text, new Date(message.at)]
  );
}
