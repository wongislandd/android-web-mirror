import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import googleProtoFiles from "google-proto-files";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promises as fs } from "node:fs";
import { WebSocket } from "ws";
import { z } from "zod";

const SIGNALING_BASE_URL = process.env.SIGNALING_BASE_URL ?? "http://localhost:8787";
const EMULATOR_GRPC_ENDPOINT = process.env.EMULATOR_GRPC_ENDPOINT ?? "127.0.0.1:8554";
const EMULATOR_GRPC_INSECURE = (process.env.EMULATOR_GRPC_INSECURE ?? "true").toLowerCase() === "true";
const EMULATOR_GRPC_BEARER_TOKEN = process.env.EMULATOR_GRPC_BEARER_TOKEN ?? "";
const FRAME_WIDTH = Number(process.env.FRAME_WIDTH ?? 0);
const FRAME_HEIGHT = Number(process.env.FRAME_HEIGHT ?? 0);
const FRAME_FORMAT = (process.env.FRAME_FORMAT ?? "PNG").toUpperCase();
const MAX_WS_BUFFERED_BYTES = Number(process.env.MAX_WS_BUFFERED_BYTES ?? 1_500_000);
const AUTO_CREATE_SESSION = (process.env.AUTO_CREATE_SESSION ?? "true").toLowerCase() === "true";
const POINTER_MOVE_MIN_INTERVAL_MS = Number(process.env.POINTER_MOVE_MIN_INTERVAL_MS ?? 16);
const POINTER_MOVE_MIN_DELTA_PX = Number(process.env.POINTER_MOVE_MIN_DELTA_PX ?? 8);

const controlEnvelopeSchema = z.object({
  t: z.literal("control"),
  event: z.unknown(),
});

const pointerEventSchema = z.object({
  type: z.literal("pointer"),
  action: z.enum(["down", "move", "up"]),
  xNorm: z.number().min(0).max(1),
  yNorm: z.number().min(0).max(1),
  timestampMs: z.number().int().optional(),
});

const keyEventSchema = z.object({
  type: z.literal("key"),
  action: z.enum(["down", "up"]),
  keyCode: z.number().int().optional(),
  key: z.string().optional(),
});

const navEventSchema = z.object({
  type: z.literal("nav"),
  action: z.enum(["home", "back", "recent", "rotate", "power"]),
});

type SessionDetails = {
  sessionId: string;
  controllerToken: string;
  viewerToken: string;
  agentToken: string;
  joinUrlController: string;
  joinUrlViewer: string;
};

type DisplaySize = { width: number; height: number };

const wsUrlFromBase = (url: string): string => {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/ws";
  parsed.search = "";
  return parsed.toString();
};

const maybeCreateSession = async (): Promise<SessionDetails> => {
  if (!AUTO_CREATE_SESSION) {
    const sessionId = process.env.SESSION_ID;
    const agentToken = process.env.AGENT_TOKEN;
    const controllerToken = process.env.CONTROLLER_TOKEN;
    const viewerToken = process.env.VIEWER_TOKEN;

    if (!sessionId || !agentToken || !controllerToken || !viewerToken) {
      throw new Error("SESSION_ID, AGENT_TOKEN, CONTROLLER_TOKEN, and VIEWER_TOKEN are required when AUTO_CREATE_SESSION=false");
    }

    const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
    return {
      sessionId,
      agentToken,
      controllerToken,
      viewerToken,
      joinUrlController: `${webOrigin}?sessionId=${sessionId}&token=${encodeURIComponent(controllerToken)}`,
      joinUrlViewer: `${webOrigin}?sessionId=${sessionId}&token=${encodeURIComponent(viewerToken)}`,
    };
  }

  const emulatorId = process.env.EMULATOR_ID ?? EMULATOR_GRPC_ENDPOINT;
  const response = await fetch(`${SIGNALING_BASE_URL}/api/dev/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emulatorId, expiresInSec: 3600 }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as SessionDetails;
};

const fileDir = path.dirname(fileURLToPath(import.meta.url));
const protoPath = path.resolve(fileDir, "../proto/emulator_controller.proto");

const packageDefinition = protoLoader.loadSync(protoPath, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.dirname(protoPath), googleProtoFiles.getProtoPath()],
});

const loaded = grpc.loadPackageDefinition(packageDefinition) as any;
const EmulatorController = loaded.android?.emulation?.control?.EmulatorController;

if (!EmulatorController) {
  throw new Error("Unable to load EmulatorController from proto");
}

const credentials = EMULATOR_GRPC_INSECURE ? grpc.credentials.createInsecure() : grpc.credentials.createSsl();
const grpcClient = new EmulatorController(EMULATOR_GRPC_ENDPOINT, credentials) as grpc.Client & {
  streamScreenshot: (req: unknown, metadata?: grpc.Metadata) => grpc.ClientReadableStream<any>;
  sendTouch: (req: unknown, metadata: grpc.Metadata, cb: (err: grpc.ServiceError | null) => void) => void;
  sendKey: (req: unknown, metadata: grpc.Metadata, cb: (err: grpc.ServiceError | null) => void) => void;
};

const getEndpointPort = (endpoint: string): string => {
  const defaultPort = "8554";
  try {
    const asUrl = endpoint.includes("://") ? new URL(endpoint) : new URL(`http://${endpoint}`);
    return asUrl.port || defaultPort;
  } catch {
    const idx = endpoint.lastIndexOf(":");
    if (idx === -1) return defaultPort;
    return endpoint.slice(idx + 1) || defaultPort;
  }
};

const parseIni = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
};

const discoverGrpcToken = async (endpoint: string): Promise<string> => {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return "";

  const runningDir = path.join(localAppData, "Temp", "avd", "running");
  const desiredPort = getEndpointPort(endpoint);

  try {
    const entries = await fs.readdir(runningDir);
    const iniFiles = entries.filter((name) => /^pid_\d+\.ini$/.test(name));
    if (iniFiles.length === 0) return "";

    const parsed = await Promise.all(
      iniFiles.map(async (name) => {
        const fullPath = path.join(runningDir, name);
        const stat = await fs.stat(fullPath);
        const content = await fs.readFile(fullPath, "utf8");
        return { stat, values: parseIni(content) };
      }),
    );

    parsed.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const exact = parsed.find((p) => p.values["grpc.port"] === desiredPort && p.values["grpc.token"]);
    if (exact) return exact.values["grpc.token"];

    const any = parsed.find((p) => p.values["grpc.token"]);
    return any?.values["grpc.token"] ?? "";
  } catch {
    return "";
  }
};

let grpcMetadata = new grpc.Metadata();

const unaryWithMetadata = async (method: "sendTouch" | "sendKey", payload: unknown): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    grpcClient[method](payload, grpcMetadata, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

const screenshotRequest = {
  format: {
    format: FRAME_FORMAT,
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    display: 0,
  },
};

const main = async (): Promise<void> => {
  const resolvedToken = EMULATOR_GRPC_BEARER_TOKEN || (await discoverGrpcToken(EMULATOR_GRPC_ENDPOINT));
  grpcMetadata = new grpc.Metadata();
  if (resolvedToken) {
    grpcMetadata.add("authorization", `Bearer ${resolvedToken}`);
  }

  const session = await maybeCreateSession();
  console.log(`grpc endpoint=${EMULATOR_GRPC_ENDPOINT}`);
  console.log(`grpc auth token=${resolvedToken ? "present" : "missing"}`);
  console.log(`sessionId=${session.sessionId}`);
  console.log(`controller: ${session.joinUrlController}`);
  console.log(`viewer: ${session.joinUrlViewer}`);

  const ws = new WebSocket(wsUrlFromBase(SIGNALING_BASE_URL));

  let currentDisplay: DisplaySize | null = null;
  let touchActive = false;
  let lastMoveTs = 0;
  let lastSentX = 0;
  let lastSentY = 0;

  const commandQueue: Array<() => Promise<void>> = [];
  let pendingMove: (() => Promise<void>) | null = null;
  let workerRunning = false;

  const processQueue = (): void => {
    if (workerRunning) return;
    workerRunning = true;

    void (async () => {
      while (commandQueue.length > 0 || pendingMove) {
        const next = commandQueue.length > 0 ? commandQueue.shift()! : pendingMove!;
        if (commandQueue.length === 0 && pendingMove === next) {
          pendingMove = null;
        }
        try {
          await next();
        } catch (error) {
          console.error("control command failed", error);
        }
      }
      workerRunning = false;
      if (commandQueue.length > 0 || pendingMove) {
        processQueue();
      }
    })();
  };

  const enqueue = (fn: () => Promise<void>, coalesceMove = false): void => {
    if (coalesceMove) pendingMove = fn;
    else commandQueue.push(fn);
    processQueue();
  };

  const resolvePoint = (xNorm: number, yNorm: number): { x: number; y: number } | null => {
    if (!currentDisplay) return null;
    return {
      x: Math.round(xNorm * currentDisplay.width),
      y: Math.round(yNorm * currentDisplay.height),
    };
  };

  ws.on("open", () => {
    ws.send(JSON.stringify({ t: "hello", token: session.agentToken }));
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;

    let message: unknown;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const controlEnvelope = controlEnvelopeSchema.safeParse(message);
    if (!controlEnvelope.success) {
      return;
    }

    const pointer = pointerEventSchema.safeParse(controlEnvelope.data.event);
    if (pointer.success) {
      const point = resolvePoint(pointer.data.xNorm, pointer.data.yNorm);
      if (!point) return;

      const now = Date.now();

      if (pointer.data.action === "down") {
        touchActive = true;
        lastMoveTs = now;
        lastSentX = point.x;
        lastSentY = point.y;
        enqueue(() =>
          unaryWithMetadata("sendTouch", {
            touches: [{ x: point.x, y: point.y, identifier: 0, pressure: 180, expiration: "NEVER_EXPIRE" }],
            display: 0,
          }),
        );
      }

      if (pointer.data.action === "move" && touchActive) {
        const delta = Math.abs(point.x - lastSentX) + Math.abs(point.y - lastSentY);
        if (now - lastMoveTs >= POINTER_MOVE_MIN_INTERVAL_MS && delta >= POINTER_MOVE_MIN_DELTA_PX) {
          lastMoveTs = now;
          lastSentX = point.x;
          lastSentY = point.y;
          enqueue(
            () =>
              unaryWithMetadata("sendTouch", {
                touches: [{ x: point.x, y: point.y, identifier: 0, pressure: 180, expiration: "NEVER_EXPIRE" }],
                display: 0,
              }),
            true,
          );
        }
      }

      if (pointer.data.action === "up" && touchActive) {
        touchActive = false;
        enqueue(() =>
          unaryWithMetadata("sendTouch", {
            touches: [{ x: point.x, y: point.y, identifier: 0, pressure: 0, expiration: "NEVER_EXPIRE" }],
            display: 0,
          }),
        );
      }

      return;
    }

    const keyEvent = keyEventSchema.safeParse(controlEnvelope.data.event);
    if (keyEvent.success && keyEvent.data.action === "down") {
      const key = keyEvent.data.key;
      if (key && key.length > 0) {
        enqueue(() => unaryWithMetadata("sendKey", { key, eventType: "keypress" }));
      } else if (typeof keyEvent.data.keyCode === "number") {
        enqueue(() => unaryWithMetadata("sendKey", { keyCode: keyEvent.data.keyCode, codeType: "Win", eventType: "keypress" }));
      }
      return;
    }

    const nav = navEventSchema.safeParse(controlEnvelope.data.event);
    if (nav.success) {
      const keyMap: Record<typeof nav.data.action, string> = {
        home: "GoHome",
        back: "GoBack",
        recent: "AppSwitch",
        power: "Power",
        rotate: "",
      };

      if (nav.data.action === "rotate") {
        enqueue(() => unaryWithMetadata("sendKey", { key: "RotateScreen", eventType: "keypress" }));
      } else {
        enqueue(() => unaryWithMetadata("sendKey", { key: keyMap[nav.data.action], eventType: "keypress" }));
      }
    }
  });

  ws.on("close", (code, reason) => {
    console.error(`ws closed code=${code} reason=${reason.toString()}`);
    process.exit(1);
  });

  ws.on("error", (err) => {
    console.error("ws error", err);
  });

  const screenshotStream = grpcClient.streamScreenshot(screenshotRequest, grpcMetadata);

  screenshotStream.on("data", (frame: any) => {
    const image: Buffer = frame?.image;
    const width = Number(frame?.format?.width ?? 0);
    const height = Number(frame?.format?.height ?? 0);
    if (width > 0 && height > 0) {
      currentDisplay = { width, height };
    }

    if (!image || image.length === 0) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) return;

    ws.send(Buffer.from(image), { binary: true });
  });

  screenshotStream.on("error", (error) => {
    console.error("gRPC screenshot stream error", error);
    process.exit(1);
  });

  screenshotStream.on("end", () => {
    console.error("gRPC screenshot stream ended");
    process.exit(1);
  });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
