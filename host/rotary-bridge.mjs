import { spawn } from "node:child_process";

const ADB = process.env.CAR_THING_ADB || "adb";
const SERIAL = process.env.CAR_THING_SERIAL || "";
const CDP_PORT = Number(process.env.CARTHINGY_CDP_PORT ?? 9222);

function adbArgs(rest) {
  return SERIAL ? ["-s", SERIAL, ...rest] : rest;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureForward() {
  spawn(ADB, adbArgs(["forward", `tcp:${CDP_PORT}`, "tcp:2222"]), { stdio: "ignore" });
}

async function pageWs() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
    if (!res.ok) return null;
    const pages = await res.json();
    const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    return page?.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

async function dispatchArrow(wsUrl, direction) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cdp timeout")), 1500);
    ws.onopen = () => {
      const key = direction === "+" ? "ArrowRight" : "ArrowLeft";
      const vk = direction === "+" ? 39 : 37;
      ws.send(JSON.stringify({
        id: 1,
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", windowsVirtualKeyCode: vk, key, code: key },
      }));
      ws.send(JSON.stringify({
        id: 2,
        method: "Input.dispatchKeyEvent",
        params: { type: "keyUp", windowsVirtualKeyCode: vk, key, code: key },
      }));
      setTimeout(() => {
        clearTimeout(timer);
        ws.close();
        resolve();
      }, 40);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("cdp error"));
    };
  });
}

async function main() {
  await ensureForward();
  const child = spawn(ADB, adbArgs(["shell", "python", "/usr/share/claudethingy/rotary-reader.py"]), {
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.on("data", () => {});
  console.log("rotary bridge listening");

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", async (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const dir = line.trim();
      if (dir !== "+" && dir !== "-") continue;
      const wsUrl = await pageWs();
      if (!wsUrl) continue;
      try {
        await dispatchArrow(wsUrl, dir);
      } catch {
        await ensureForward();
      }
    }
  });

  child.on("exit", async (code) => {
    console.log(`rotary reader exited ${code}`);
    await sleep(2000);
    main().catch(() => {});
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
