import { createServer } from "http";
import { randomUUID } from "crypto";
import { loadEnvConfig } from "@next/env";
import next from "next";
import { Server } from "socket.io";
import {
  closeDatabase,
  getRecentMessages,
  initializeDatabase,
  saveMessage,
} from "./database.js";

loadEnvConfig(process.cwd());
const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

const users = new Map(); // socket.id -> username
const MAX_HISTORY = 100;

function broadcastUsers(io) {
  io.emit("users:update", Array.from(users.values()));
}

async function startServer() {
  await app.prepare();
  await initializeDatabase();

  const httpServer = createServer((req, res) => {
    handle(req, res);
  });

  const io = new Server(httpServer, {
    cors: { origin: "*" },
  });

  io.on("connection", (socket) => {
    getRecentMessages(MAX_HISTORY)
      .then((history) => socket.emit("messages:history", history))
      .catch((error) => {
        console.error("Failed to load message history:", error);
        socket.emit(
          "chat:error",
          "Could not load message history. Please try again later."
        );
      });

    socket.on("join", (username) => {
      const name = String(username || "anon").slice(0, 24) || "anon";
      users.set(socket.id, name);
      broadcastUsers(io);
      socket.broadcast.emit("chat:system", `${name} joined`);
    });

    socket.on("chat:message", async (payload) => {
      const user = users.get(socket.id) || "anon";
      const text = String(payload?.text ?? "").slice(0, 1000).trim();
      if (!text) return;
      const msg = {
        id: randomUUID(),
        user,
        text,
        at: Date.now(),
      };
      try {
        await saveMessage(msg);
        io.emit("chat:message", msg);
      } catch (error) {
        console.error("Failed to save chat message:", error);
        socket.emit(
          "chat:error",
          "Message could not be saved. Please try again."
        );
      }
    });

    socket.on("typing", (isTyping) => {
      const user = users.get(socket.id);
      if (!user) return;
      socket.broadcast.emit("typing", { user, isTyping: !!isTyping });
    });

    socket.on("disconnect", () => {
      const name = users.get(socket.id);
      users.delete(socket.id);
      broadcastUsers(io);
      if (name) socket.broadcast.emit("chat:system", `${name} left`);
    });
  });

  httpServer.listen(port, () => {
    console.log(
      `> Server listening at http://localhost:${port} as ${
        dev ? "development" : process.env.NODE_ENV
      }`
    );
  });
}

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
