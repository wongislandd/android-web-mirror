import cors from "cors";
import express from "express";
import jwt from "jsonwebtoken";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

type Role = "agent" | "controller" | "viewer";

type TokenPayload = {
  sessionId: string;
  role: Role;
};

type Peer = {
  id: string;
  role: Role;
  ws: WebSocket;
};

type Session = {
  id: string;
  emulatorId: string;
  createdAt: number;
  expiresAt: number;
  lockOwnerPeerId: string | null;
  peers: Map<string, Peer>;
};

const PORT = Number(process.env.PORT ?? 8787);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const SESSION_SIGNING_KEY = process.env.SESSION_SIGNING_KEY ?? "dev-only-secret";
const SESSION_DEFAULT_TTL_SEC = Number(process.env.SESSION_DEFAULT_TTL_SEC ?? 3600);

const sessions = new Map<string, Session>();

const app = express();
app.use(cors());
app.use(express.json());

const createSessionBodySchema = z.object({
  emulatorId: z.string().min(1).optional(),
  expiresInSec: z.number().int().min(60).max(24 * 3600).optional(),
});

const issueToken = (sessionId: string, role: Role, expiresInSec: number): string => {
  return jwt.sign({ sessionId, role } satisfies TokenPayload, SESSION_SIGNING_KEY, {
    expiresIn: expiresInSec,
    issuer: "android-browser-mirror-poc",
    audience: "local-dev",
  });
};

app.post("/api/dev/sessions", (req, res) => {
  const parsed = createSessionBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const sessionId = randomUUID();
  const emulatorId = parsed.data.emulatorId ?? "emulator-5554";
  const expiresInSec = parsed.data.expiresInSec ?? SESSION_DEFAULT_TTL_SEC;
  const now = Date.now();

  const session: Session = {
    id: sessionId,
    emulatorId,
    createdAt: now,
    expiresAt: now + expiresInSec * 1000,
    lockOwnerPeerId: null,
    peers: new Map(),
  };

  sessions.set(sessionId, session);

  const controllerToken = issueToken(sessionId, "controller", expiresInSec);
  const viewerToken = issueToken(sessionId, "viewer", expiresInSec);
  const agentToken = issueToken(sessionId, "agent", expiresInSec);

  return res.status(201).json({
    sessionId,
    emulatorId,
    expiresAt: new Date(session.expiresAt).toISOString(),
    joinUrlController: `${WEB_ORIGIN}?sessionId=${sessionId}&token=${encodeURIComponent(controllerToken)}`,
    joinUrlViewer: `${WEB_ORIGIN}?sessionId=${sessionId}&token=${encodeURIComponent(viewerToken)}`,
    controllerToken,
    viewerToken,
    agentToken,
  });
});

app.get("/api/dev/health", (_req, res) => {
  const now = Date.now();
  let activeSessions = 0;
  let activePeers = 0;

  for (const session of sessions.values()) {
    if (session.expiresAt > now) {
      activeSessions += 1;
      activePeers += session.peers.size;
    }
  }

  res.json({
    ok: true,
    activeSessions,
    activePeers,
    timestamp: new Date(now).toISOString(),
  });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

const helloSchema = z.object({
  t: z.literal("hello"),
  token: z.string().min(1),
});

const signalSchema = z.object({
  t: z.enum(["offer", "answer", "ice"]),
  payload: z.unknown(),
});

const controlSchema = z.object({
  t: z.literal("control"),
  event: z.unknown(),
});

const lockSchema = z.object({
  t: z.literal("lock"),
  action: z.enum(["request", "release"]),
});

const frameSchema = z.object({
  t: z.literal("frame"),
  mime: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  dataBase64: z.string(),
  ts: z.number().int(),
});

const sendJson = (ws: WebSocket, payload: unknown): void => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
};

const broadcastSessionState = (session: Session): void => {
  const peers = [...session.peers.values()];
  const lockOwner = session.lockOwnerPeerId;
  for (const peer of peers) {
    sendJson(peer.ws, {
      t: "session_state",
      sessionId: session.id,
      lockOwnerPeerId: lockOwner,
      peers: peers.map((p) => ({ id: p.id, role: p.role })),
    });
  }
};

const findSession = (sessionId: string): Session | null => {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    for (const peer of session.peers.values()) {
      sendJson(peer.ws, { t: "error", message: "Session expired" });
      peer.ws.close(4001, "Session expired");
    }
    sessions.delete(sessionId);
    return null;
  }
  return session;
};

const relayByRole = (session: Session, role: Role, payload: unknown): void => {
  for (const peer of session.peers.values()) {
    if (peer.role === role) {
      sendJson(peer.ws, payload);
    }
  }
};

wss.on("connection", (ws) => {
  let peer: Peer | null = null;
  let sessionId = "";

  ws.on("message", (rawMessage) => {
    let message: unknown;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      sendJson(ws, { t: "error", message: "Invalid JSON message" });
      return;
    }

    if (!peer) {
      const hello = helloSchema.safeParse(message);
      if (!hello.success) {
        sendJson(ws, { t: "error", message: "First message must be hello" });
        ws.close(4000, "Auth required");
        return;
      }

      try {
        const decoded = jwt.verify(hello.data.token, SESSION_SIGNING_KEY, {
          issuer: "android-browser-mirror-poc",
          audience: "local-dev",
        }) as TokenPayload;

        const session = findSession(decoded.sessionId);
        if (!session) {
          sendJson(ws, { t: "error", message: "Session not found" });
          ws.close(4004, "Session not found");
          return;
        }

        peer = {
          id: randomUUID(),
          role: decoded.role,
          ws,
        };
        sessionId = decoded.sessionId;
        session.peers.set(peer.id, peer);

        if (!session.lockOwnerPeerId && peer.role === "controller") {
          session.lockOwnerPeerId = peer.id;
        }

        sendJson(ws, {
          t: "hello_ack",
          peerId: peer.id,
          role: peer.role,
          sessionId,
          emulatorId: session.emulatorId,
        });
        broadcastSessionState(session);
      } catch {
        sendJson(ws, { t: "error", message: "Invalid token" });
        ws.close(4003, "Invalid token");
      }
      return;
    }

    const session = findSession(sessionId);
    if (!session) {
      ws.close(4004, "Session not found");
      return;
    }

    const signal = signalSchema.safeParse(message);
    if (signal.success) {
      if (peer.role === "agent") {
        relayByRole(session, "controller", { t: signal.data.t, payload: signal.data.payload });
        relayByRole(session, "viewer", { t: signal.data.t, payload: signal.data.payload });
      } else {
        relayByRole(session, "agent", { t: signal.data.t, payload: signal.data.payload });
      }
      return;
    }

    const frame = frameSchema.safeParse(message);
    if (frame.success && peer.role === "agent") {
      relayByRole(session, "controller", frame.data);
      relayByRole(session, "viewer", frame.data);
      return;
    }

    const control = controlSchema.safeParse(message);
    if (control.success && peer.role !== "agent") {
      if (session.lockOwnerPeerId !== peer.id) {
        sendJson(ws, { t: "error", message: "Not lock owner" });
        return;
      }
      relayByRole(session, "agent", control.data);
      return;
    }

    const lock = lockSchema.safeParse(message);
    if (lock.success) {
      if (lock.data.action === "request") {
        if (!session.lockOwnerPeerId || session.lockOwnerPeerId === peer.id) {
          session.lockOwnerPeerId = peer.id;
          sendJson(ws, { t: "lock_result", granted: true, ownerPeerId: peer.id });
        } else {
          sendJson(ws, { t: "lock_result", granted: false, ownerPeerId: session.lockOwnerPeerId });
        }
      }

      if (lock.data.action === "release" && session.lockOwnerPeerId === peer.id) {
        session.lockOwnerPeerId = null;
      }

      broadcastSessionState(session);
      return;
    }

    sendJson(ws, { t: "error", message: "Unknown message" });
  });

  ws.on("close", () => {
    if (!peer || !sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    session.peers.delete(peer.id);

    if (session.lockOwnerPeerId === peer.id) {
      session.lockOwnerPeerId = null;
      const nextController = [...session.peers.values()].find((p) => p.role === "controller");
      if (nextController) {
        session.lockOwnerPeerId = nextController.id;
      }
    }

    if (session.peers.size === 0) {
      sessions.delete(sessionId);
      return;
    }

    broadcastSessionState(session);
  });
});

httpServer.listen(PORT, () => {
  console.log(`signaling server listening on http://localhost:${PORT}`);
});
