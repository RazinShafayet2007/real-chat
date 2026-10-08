import { createServer } from "http";
import next from "next";
import { Server } from "socket.io";

const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

/** @typedef {{ id: string; user: string; text: string; at: number }} ChatMessage */

const users = new Map(); // socket.id -> username
/** @type {ChatMessage[]} */
const history = [];
const MAX_HISTORY = 100;

function broadcastUsers(io) {
  io.emit("users:update", Array.from(users.values()));
}

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    handle(req, res);
  });

  const io = new Server(httpServer, {
    cors: { origin: "*" },
  });

  io.on("connection", (socket) => {
    socket.emit("messages:history", history);

    socket.on("join", (username) => {
      const name = String(username || "anon").slice(0, 24) || "anon";
      users.set(socket.id, name);
      broadcastUsers(io);
      socket.broadcast.emit("chat:system", `${name} joined`);
    });

    socket.on("chat:message", (payload) => {
      const user = users.get(socket.id) || "anon";
      const text = String(payload?.text ?? "").slice(0, 1000).trim();
      if (!text) return;
      const msg = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        user,
        text,
        at: Date.now(),
      };
      history.push(msg);
      if (history.length > MAX_HISTORY) history.shift();
      io.emit("chat:message", msg);
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
});
