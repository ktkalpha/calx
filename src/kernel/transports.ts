import type { FromKernel, ToKernel } from "./protocol";
import KernelWorker from "./worker?worker";

export type KernelKind = "native" | "pyodide";

export interface TransportEvents {
  message(msg: FromKernel): void;
  /** The kernel died or could not start. */
  crashed(reason: string): void;
}

/** How the UI talks to a Python interpreter. */
export interface Transport {
  readonly kind: KernelKind;
  start(events: TransportEvents): void;
  send(msg: ToKernel): void;
  /** Abort the running code. Returns false if that requires a restart (state is lost). */
  interrupt(): boolean;
  stop(): void;
}

export const inTauri = () => "__TAURI_INTERNALS__" in window;

/** Pyodide (CPython compiled to WebAssembly) in a Web Worker. Always available, sandboxed. */
export class PyodideTransport implements Transport {
  readonly kind = "pyodide";
  private worker?: Worker;

  start(events: TransportEvents) {
    this.worker = new KernelWorker();
    this.worker.onmessage = (ev: MessageEvent<FromKernel>) => {
      const msg = ev.data;
      events.message(msg.type === "ready" ? { ...msg, kernel: "pyodide" } : msg);
    };
    this.worker.onerror = (ev) => events.crashed(ev.message || "kernel crashed");
  }

  send(msg: ToKernel) {
    this.worker?.postMessage(msg);
  }

  interrupt() {
    return false;
  }

  stop() {
    this.worker?.terminate();
  }
}

interface Line {
  gen: number;
  line: string;
}

let generation = 0;

/** The user's own python3, run by the Tauri backend (src-tauri/src/kernel.rs). */
export class NativeTransport implements Transport {
  readonly kind = "native";
  private gen = ++generation;
  private unlisten: (() => void)[] = [];
  private lastRun = 0;
  private stopped = false;

  constructor(private python: string | null) {}

  start(events: TransportEvents) {
    void this.boot(events);
  }

  private async boot(events: TransportEvents) {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    const mine = (fn: (l: Line) => void) => (ev: { payload: Line }) => {
      if (ev.payload.gen === this.gen && !this.stopped) fn(ev.payload);
    };
    this.unlisten = await Promise.all([
      listen<Line>("kernel://msg", mine((l) => {
        try {
          events.message(JSON.parse(l.line) as FromKernel);
        } catch {
          events.message({ type: "stdout", id: this.lastRun, text: l.line });
        }
      })),
      // raw fd output: subprocesses, C extensions, interpreter crashes
      listen<Line>("kernel://raw", mine((l) => events.message({ type: "stdout", id: this.lastRun, text: l.line }))),
      listen<Line>("kernel://exit", mine(() => events.crashed("python process exited"))),
    ]);
    if (this.stopped) return this.cleanup();
    events.message({ type: "status", text: "starting python3" });
    try {
      await invoke("kernel_start", { gen: this.gen, python: this.python });
    } catch (e) {
      if (!this.stopped) events.crashed(String(e));
    }
  }

  send(msg: ToKernel) {
    if (msg.type === "run") this.lastRun = msg.id;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("kernel_send", { line: JSON.stringify(msg) }));
  }

  interrupt() {
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("kernel_interrupt"));
    return true;
  }

  stop() {
    this.stopped = true;
    this.cleanup();
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("kernel_stop"));
  }

  private cleanup() {
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
  }
}
