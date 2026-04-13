const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 7860;

app.get("/", (req, res) => {
  res.send("GeoFS dual control final server is running.");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

const server = http.createServer(app);

const wss = new WebSocket.Server({
  server,
  path: "/ws"
});

// rooms:
// {
//   host: WebSocket|null,
//   copilots: Set<WebSocket>,
//   password: string,
//   latestHostState: object|null,
//   latestCopilotControls: object|null
// }
const rooms = new Map();

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      host: null,
      copilots: new Set(),
      password: "",
      latestHostState: null,
      latestCopilotControls: null
    });
  }
  return rooms.get(roomId);
}

function cleanupSocket(ws) {
  for (const [roomId, room] of rooms.entries()) {
    if (room.host === ws) {
      room.host = null;
    }
    room.copilots.delete(ws);

    if (!room.host && room.copilots.size === 0) {
      rooms.delete(roomId);
    }
  }
}

function broadcastRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const payload = {
    type: "room_state",
    roomId,
    hostOnline: !!room.host,
    copilotCount: room.copilots.size
  };

  if (room.host) safeSend(room.host, payload);
  for (const cp of room.copilots) {
    safeSend(cp, payload);
  }
}

wss.on("connection", (ws) => {
  ws._roomId = null;
  ws._role = null;

  safeSend(ws, { type: "info", message: "connected" });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      safeSend(ws, { type: "error", message: "invalid json" });
      return;
    }

    if (msg.type === "join") {
      const roomId = String(msg.roomId || "").trim();
      const role = String(msg.role || "").trim();
      const password = String(msg.password || "");

      if (!roomId || !["host", "copilot"].includes(role)) {
        safeSend(ws, { type: "error", message: "invalid join params" });
        return;
      }

      cleanupSocket(ws);

      const room = getOrCreateRoom(roomId);

      if (!room.password && role === "host") {
        room.password = password;
      } else if (room.password !== password) {
        safeSend(ws, { type: "error", message: "wrong password" });
        return;
      }

      ws._roomId = roomId;
      ws._role = role;

      if (role === "host") {
        if (room.host && room.host !== ws) {
          safeSend(room.host, { type: "info", message: "another host replaced you" });
          try { room.host.close(); } catch (_) {}
        }
        room.host = ws;
      } else {
        room.copilots.add(ws);
      }

      safeSend(ws, {
        type: "joined",
        roomId,
        role
      });

      broadcastRoomState(roomId);
      return;
    }

    if (!ws._roomId) {
      safeSend(ws, { type: "error", message: "join first" });
      return;
    }

    const room = rooms.get(ws._roomId);
    if (!room) {
      safeSend(ws, { type: "error", message: "room not found" });
      return;
    }

    if (msg.type === "ping") {
      safeSend(ws, {
        type: "pong",
        clientTs: msg.clientTs || 0,
        serverTs: Date.now()
      });
      return;
    }

    if (msg.type === "host_state" && ws._role === "host") {
      room.latestHostState = msg.data || null;
      const payload = {
        type: "host_state",
        ts: Date.now(),
        data: room.latestHostState
      };
      for (const cp of room.copilots) {
        safeSend(cp, payload);
      }
      return;
    }

    if (msg.type === "copilot_controls" && ws._role === "copilot") {
      room.latestCopilotControls = msg.data || null;
      if (room.host) {
        safeSend(room.host, {
          type: "copilot_controls",
          ts: Date.now(),
          data: room.latestCopilotControls
        });
      }
      return;
    }
  });

  ws.on("close", () => {
    const roomId = ws._roomId;
    cleanupSocket(ws);
    if (roomId) broadcastRoomState(roomId);
  });

  ws.on("error", () => {
    const roomId = ws._roomId;
    cleanupSocket(ws);
    if (roomId) broadcastRoomState(roomId);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
