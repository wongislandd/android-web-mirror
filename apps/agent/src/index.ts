import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const SIGNALING_BASE_URL = process.env.SIGNALING_BASE_URL ?? "http://localhost:8787";
const ADB_SERIAL = process.env.ADB_SERIAL ?? "emulator-5554";
const FRAME_INTERVAL_MS = Number(process.env.FRAME_INTERVAL_MS ?? 120);
const AUTO_CREATE_SESSION = (process.env.AUTO_CREATE_SESSION ?? "true").toLowerCase() === "true";

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
  keyCode: z.number().int(),
});

const navEventSchema = z.object({
  type: z.literal("nav"),
  action: z.enum(["home", "back", "recent", "rotate", "power"]),
});

type Size = { width: number; height: number };

type SessionDetails = {
  sessionId: string;
  controllerToken: string;
  viewerToken: string;
  agentToken: string;
  joinUrlController: string;
  joinUrlViewer: string;
};

const wsUrlFromBase = (url: string): string => {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/ws";
  parsed.search = "";
  return parsed.toString();
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const runAdb = async (args: string[], opts?: { encoding?: BufferEncoding | "buffer" }) => {
  return execFileAsync("adb", ["-s", ADB_SERIAL, ...args], {
    encoding: opts?.encoding ?? "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
};

const getDeviceSize = async (): Promise<Size> => {
  const { stdout } = await runAdb(["shell", "wm", "size"]);
  const text = String(stdout);
  const match = text.match(/(\d+)x(\d+)/);
  if (!match) {
    throw new Error(`Unable to parse wm size output: ${text}`);
  }
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
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

  const response = await fetch(`${SIGNALING_BASE_URL}/api/dev/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emulatorId: ADB_SERIAL, expiresInSec: 3600 }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as SessionDetails;
};

const keyMap: Record<number, number> = {
  8: 67,
  13: 66,
  27: 4,
};

const runShellInput = async (...args: string[]): Promise<void> => {
  await runAdb(["shell", "input", ...args]);
};

const main = async (): Promise<void> => {
  console.log(`connecting to emulator serial ${ADB_SERIAL}`);
  const deviceSize = await getDeviceSize();
  console.log(`detected device size ${deviceSize.width}x${deviceSize.height}`);

  const session = await maybeCreateSession();
  console.log(`sessionId=${session.sessionId}`);
  console.log(`controller: ${session.joinUrlController}`);
  console.log(`viewer: ${session.joinUrlViewer}`);

  const ws = new WebSocket(wsUrlFromBase(SIGNALING_BASE_URL));

  const pointerState = {
    isDown: false,
    startX: 0,
    startY: 0,
    latestX: 0,
    latestY: 0,
    startTs: 0,
  };

  ws.on("open", () => {
    ws.send(JSON.stringify({ t: "hello", token: session.agentToken }));
  });

  ws.on("message", async (raw) => {
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
      const x = Math.round(pointer.data.xNorm * deviceSize.width);
      const y = Math.round(pointer.data.yNorm * deviceSize.height);

      if (pointer.data.action === "down") {
        pointerState.isDown = true;
        pointerState.startX = x;
        pointerState.startY = y;
        pointerState.latestX = x;
        pointerState.latestY = y;
        pointerState.startTs = Date.now();
      }

      if (pointer.data.action === "move" && pointerState.isDown) {
        pointerState.latestX = x;
        pointerState.latestY = y;
      }

      if (pointer.data.action === "up" && pointerState.isDown) {
        pointerState.latestX = x;
        pointerState.latestY = y;
        pointerState.isDown = false;

        const distance = Math.abs(pointerState.startX - pointerState.latestX) + Math.abs(pointerState.startY - pointerState.latestY);
        const durationMs = Math.max(30, Date.now() - pointerState.startTs);

        if (distance < 16) {
          await runShellInput("tap", `${pointerState.latestX}`, `${pointerState.latestY}`);
        } else {
          await runShellInput(
            "swipe",
            `${pointerState.startX}`,
            `${pointerState.startY}`,
            `${pointerState.latestX}`,
            `${pointerState.latestY}`,
            `${Math.min(1000, durationMs)}`,
          );
        }
      }
      return;
    }

    const keyEvent = keyEventSchema.safeParse(controlEnvelope.data.event);
    if (keyEvent.success) {
      if (keyEvent.data.action === "down") {
        const androidKeyCode = keyMap[keyEvent.data.keyCode] ?? keyEvent.data.keyCode;
        await runShellInput("keyevent", `${androidKeyCode}`);
      }
      return;
    }

    const nav = navEventSchema.safeParse(controlEnvelope.data.event);
    if (nav.success) {
      if (nav.data.action === "home") await runShellInput("keyevent", "3");
      if (nav.data.action === "back") await runShellInput("keyevent", "4");
      if (nav.data.action === "recent") await runShellInput("keyevent", "187");
      if (nav.data.action === "power") await runShellInput("keyevent", "26");
      if (nav.data.action === "rotate") await runAdb(["shell", "settings", "put", "system", "user_rotation", "1"]);
    }
  });

  ws.on("close", (code, reason) => {
    console.error(`ws closed code=${code} reason=${reason.toString()}`);
    process.exit(1);
  });

  ws.on("error", (err) => {
    console.error("ws error", err);
  });

  while (true) {
    try {
      if (ws.readyState !== WebSocket.OPEN) {
        await sleep(FRAME_INTERVAL_MS);
        continue;
      }

      const { stdout } = await runAdb(["exec-out", "screencap", "-p"], { encoding: "buffer" });
      const frameBuffer = Buffer.from(stdout as Buffer);

      ws.send(
        JSON.stringify({
          t: "frame",
          mime: "image/png",
          width: deviceSize.width,
          height: deviceSize.height,
          dataBase64: frameBuffer.toString("base64"),
          ts: Date.now(),
        }),
      );
    } catch (error) {
      console.error("frame loop error", error);
      await sleep(500);
    }

    await sleep(FRAME_INTERVAL_MS);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
