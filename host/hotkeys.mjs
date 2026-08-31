import { spawn } from "node:child_process";

function parseHotkey(raw, fallbackLabel) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return { kind: "none", label: fallbackLabel };
  }

  const pipe = value.indexOf("|");
  let label = fallbackLabel;
  let spec = value;
  if (pipe > 0) {
    label = value.slice(0, pipe).trim();
    spec = value.slice(pipe + 1).trim();
  }

  if (spec.startsWith("view:")) {
    return { kind: "view", view: spec.slice(5), label };
  }

  if (spec.startsWith("http://") || spec.startsWith("https://")) {
    return { kind: "open", args: [spec], label };
  }

  if (spec.startsWith("open ") || spec === "open") {
    const args = spec.split(/\s+/).slice(1);
    if (args.length === 0) return { kind: "none", label };
    return { kind: "open", args, label };
  }

  return { kind: "none", label };
}

export function listHotkeys() {
  return [1, 2, 3, 4].map((n) => {
    const parsed = parseHotkey(process.env[`HOTKEY_${n}`], `Shortcut ${n}`);
    return { n, label: parsed.label, kind: parsed.kind };
  });
}

export function runHotkey(n) {
  const parsed = parseHotkey(process.env[`HOTKEY_${n}`], `Shortcut ${n}`);
  if (parsed.kind === "none") {
    return { ok: false, error: "unconfigured", label: parsed.label };
  }
  if (parsed.kind === "view") {
    return { ok: true, view: parsed.view, label: parsed.label };
  }

  const child = spawn("open", parsed.args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { ok: true, label: parsed.label };
}
