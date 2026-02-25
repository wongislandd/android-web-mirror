import { z } from "zod";

const params = new URLSearchParams(window.location.search);

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app missing");

app.innerHTML = `
  <style>
    :root { color-scheme: light; font-family: "Segoe UI", sans-serif; }
    body { margin: 0; background: #f4f5f7; color: #1c1d21; }
    #app { max-width: 1040px; margin: 0 auto; padding: 16px; }
    .panel { background: #ffffff; border-radius: 12px; box-shadow: 0 6px 22px rgba(0,0,0,.08); padding: 12px; margin-bottom: 12px; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    input { border: 1px solid #cfd4dc; border-radius: 8px; padding: 8px; }
    button { background: #0d5bd6; color: white; border: 0; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
    button.secondary { background: #536079; }
    .status { font-size: 13px; color: #536079; }
    .viewer { position: relative; width: min(100%, 420px); aspect-ratio: 9/19.5; border-radius: 16px; overflow: hidden; background: #111; margin-top: 12px; }
    img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .overlay { position: absolute; inset: 0; touch-action: none; }
  </style>
  <div class="panel">
    <div class="row">
      <label>Signaling <input id="signaling" value="http://localhost:8787" style="width:220px"/></label>
      <label>Session ID <input id="sessionId" style="width:320px"/></label>
      <label>Token <input id="token" style="width:360px"/></label>
      <button id="connect">Connect</button>
      <button id="requestLock" class="secondary">Request Control</button>
      <button id="releaseLock" class="secondary">Release</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button id="navBack" class="secondary">Back</button>
      <button id="navHome" class="secondary">Home</button>
      <button id="navRecent" class="secondary">Recent</button>
      <button id="navPower" class="secondary">Power</button>
    </div>
    <div class="status" id="status">Disconnected</div>
    <div class="status" id="lockStatus"></div>
  </div>
  <div class="panel">
    <div class="viewer" id="viewer">
      <img id="frame" alt="Android stream"/>
      <div class="overlay" id="overlay"></div>
    </div>
  </div>
`;

const signalingInput = document.querySelector<HTMLInputElement>("#signaling")!;
const sessionInput = document.querySelector<HTMLInputElement>("#sessionId")!;
const tokenInput = document.querySelector<HTMLInputElement>("#token")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const requestLockButton = document.querySelector<HTMLButtonElement>("#requestLock")!;
const releaseLockButton = document.querySelector<HTMLButtonElement>("#releaseLock")!;
const statusText = document.querySelector<HTMLDivElement>("#status")!;
const lockStatus = document.querySelector<HTMLDivElement>("#lockStatus")!;
const frameImg = document.querySelector<HTMLImageElement>("#frame")!;
const overlay = document.querySelector<HTMLDivElement>("#overlay")!;

sessionInput.value = params.get("sessionId") ?? "";
tokenInput.value = params.get("token") ?? "";

let ws: WebSocket | null = null;
let ownPeerId = "";
let lockOwnerPeerId: string | null = null;
let lastFrameUrl: string | null = null;
let pendingFrameBlob: Blob | null = null;
let frameRenderQueued = false;
let lastPointerMoveSentAt = 0;

const helloAckSchema = z.object({
  t: z.literal("hello_ack"),
  peerId: z.string(),
  role: z.string(),
  sessionId: z.string(),
  emulatorId: z.string(),
});

const sessionStateSchema = z.object({
  t: z.literal("session_state"),
  lockOwnerPeerId: z.string().nullable(),
  peers: z.array(z.object({ id: z.string(), role: z.string() })),
});

const lockResultSchema = z.object({
  t: z.literal("lock_result"),
  granted: z.boolean(),
  ownerPeerId: z.string().nullable().optional(),
});

const errorSchema = z.object({
  t: z.literal("error"),
  message: z.string(),
});

const send = (payload: unknown): void => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
};

const setLockStatus = (): void => {
  const youOwn = ownPeerId && lockOwnerPeerId === ownPeerId;
  lockStatus.textContent = youOwn ? "You have control" : lockOwnerPeerId ? "View-only mode" : "No active controller";
};

const normalizedPoint = (event: PointerEvent): { xNorm: number; yNorm: number } => {
  const rect = overlay.getBoundingClientRect();
  const xNorm = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const yNorm = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
  return { xNorm, yNorm };
};

const sendPointer = (action: "down" | "move" | "up", event: PointerEvent): void => {
  const point = normalizedPoint(event);
  send({
    t: "control",
    event: {
      type: "pointer",
      action,
      ...point,
      timestampMs: Date.now(),
    },
  });
};

overlay.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  overlay.setPointerCapture(event.pointerId);
  sendPointer("down", event);
});

overlay.addEventListener("pointermove", (event) => {
  if ((event.buttons & 1) === 1) {
    const now = performance.now();
    if (now - lastPointerMoveSentAt < 16) {
      return;
    }
    lastPointerMoveSentAt = now;
    sendPointer("move", event);
  }
});

overlay.addEventListener("pointerup", (event) => {
  event.preventDefault();
  sendPointer("up", event);
});

const queueFrameRender = (): void => {
  if (frameRenderQueued) return;
  frameRenderQueued = true;
  requestAnimationFrame(() => {
    frameRenderQueued = false;
    if (!pendingFrameBlob) return;

    const nextFrameUrl = URL.createObjectURL(pendingFrameBlob);
    pendingFrameBlob = null;
    frameImg.src = nextFrameUrl;
    if (lastFrameUrl) {
      URL.revokeObjectURL(lastFrameUrl);
    }
    lastFrameUrl = nextFrameUrl;
  });
};

window.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  send({
    t: "control",
    event: {
      type: "key",
      action: "down",
      keyCode: event.keyCode,
      key: event.key,
    },
  });
});

const connect = (): void => {
  const signalingUrl = signalingInput.value.trim();
  const token = tokenInput.value.trim();

  if (!token) {
    statusText.textContent = "Token required";
    return;
  }

  const wsUrl = new URL(signalingUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = "/ws";
  ws = new WebSocket(wsUrl.toString());

  ws.addEventListener("open", () => {
    statusText.textContent = "Connected";
    send({ t: "hello", token });
  });

  ws.addEventListener("close", () => {
    statusText.textContent = "Disconnected";
    ownPeerId = "";
    lockOwnerPeerId = null;
    if (lastFrameUrl) {
      URL.revokeObjectURL(lastFrameUrl);
      lastFrameUrl = null;
    }
    setLockStatus();
  });

  ws.addEventListener("message", (raw) => {
    if (raw.data instanceof Blob) {
      pendingFrameBlob = raw.data;
      queueFrameRender();
      return;
    }

    if (typeof raw.data !== "string") {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(raw.data);
    } catch {
      return;
    }

    const helloAck = helloAckSchema.safeParse(message);
    if (helloAck.success) {
      ownPeerId = helloAck.data.peerId;
      sessionInput.value = helloAck.data.sessionId;
      statusText.textContent = `Connected to ${helloAck.data.emulatorId} as ${helloAck.data.role}`;
      setLockStatus();
      return;
    }

    const state = sessionStateSchema.safeParse(message);
    if (state.success) {
      lockOwnerPeerId = state.data.lockOwnerPeerId;
      setLockStatus();
      return;
    }

    const lockResult = lockResultSchema.safeParse(message);
    if (lockResult.success) {
      if (!lockResult.data.granted) {
        statusText.textContent = "Control request denied";
      } else {
        statusText.textContent = "Control granted";
      }
      return;
    }

    const err = errorSchema.safeParse(message);
    if (err.success) {
      statusText.textContent = `Error: ${err.data.message}`;
    }
  });
};

connectButton.addEventListener("click", () => connect());
requestLockButton.addEventListener("click", () => send({ t: "lock", action: "request" }));
releaseLockButton.addEventListener("click", () => send({ t: "lock", action: "release" }));

document.querySelector<HTMLButtonElement>("#navBack")?.addEventListener("click", () => {
  send({ t: "control", event: { type: "nav", action: "back" } });
});
document.querySelector<HTMLButtonElement>("#navHome")?.addEventListener("click", () => {
  send({ t: "control", event: { type: "nav", action: "home" } });
});
document.querySelector<HTMLButtonElement>("#navRecent")?.addEventListener("click", () => {
  send({ t: "control", event: { type: "nav", action: "recent" } });
});
document.querySelector<HTMLButtonElement>("#navPower")?.addEventListener("click", () => {
  send({ t: "control", event: { type: "nav", action: "power" } });
});

if (tokenInput.value) {
  connect();
}
