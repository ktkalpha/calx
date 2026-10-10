import type { FromKernel, Series, ToKernel, View } from "./protocol";
import { type KernelKind, NativeTransport, PyodideTransport, type Transport } from "./transports";

export type KernelState = "booting" | "idle" | "running" | "dead";

type Listener = (msg: FromKernel) => void;

/** Kernel session on top of a transport: run bookkeeping, sampling, interrupt and restart. */
export class Kernel {
  private transport!: Transport;
  private nextId = 1;
  private nextReq = 1;
  private pending = new Map<number, (ok: boolean) => void>();
  private samplers = new Map<number, (series: Series[]) => void>();
  private running = 0;
  private label = "";
  state: KernelState = "booting";

  constructor(
    public kind: KernelKind,
    public python: string | null,
    private onMessage: Listener,
    private onState: (s: KernelState, detail?: string) => void,
    private onCrash: (reason: string, kind: KernelKind) => void,
  ) {
    this.start();
  }

  private start() {
    this.setState("booting", "booting");
    this.transport = this.kind === "native" ? new NativeTransport(this.python) : new PyodideTransport();
    const transport = this.transport;
    transport.start({
      message: (msg) => transport === this.transport && this.handle(msg),
      crashed: (reason) => {
        if (transport !== this.transport) return;
        this.abandon();
        this.setState("dead", "stopped");
        this.onCrash(reason, transport.kind);
      },
    });
  }

  private setState(s: KernelState, detail?: string) {
    this.state = s;
    this.onState(s, detail);
  }

  private handle(msg: FromKernel) {
    switch (msg.type) {
      case "status":
        if (this.state !== "idle") this.onState(this.state, msg.text);
        break;
      case "ready":
        this.label = `${msg.kernel === "native" ? "python" : "pyodide"} ${msg.python}`;
        this.setState(this.running ? "running" : "idle", this.running ? "running" : this.label);
        break;
      case "fatal":
        this.setState("dead", "failed to start");
        break;
      case "done":
        this.running--;
        this.pending.get(msg.id)?.(msg.ok);
        this.pending.delete(msg.id);
        if (this.running === 0 && this.state === "running") this.setState("idle", this.label);
        break;
      case "samples":
        this.samplers.get(msg.reqId)?.(msg.series);
        this.samplers.delete(msg.reqId);
        return;
    }
    this.onMessage(msg);
  }

  private send(msg: ToKernel) {
    this.transport.send(msg);
  }

  run(code: string): { id: number; done: Promise<boolean> } {
    const id = this.nextId++;
    const done = new Promise<boolean>((resolve) => this.pending.set(id, resolve));
    this.running++;
    if (this.state === "idle") this.setState("running", "running");
    this.send({ type: "run", id, code });
    return { id, done };
  }

  input(value: string | null) {
    this.send(value == null ? { type: "input", eof: true } : { type: "input", value });
  }

  sample(ids: string[], view: Required<{ [K in keyof View]: number }>, n: number): Promise<Series[]> {
    const reqId = this.nextReq++;
    return new Promise((resolve) => {
      this.samplers.set(reqId, resolve);
      this.send({ type: "sample", reqId, ids, view, n });
    });
  }

  /**
   * Stop the running code. The native kernel gets a KeyboardInterrupt and keeps its variables;
   * pyodide can't be interrupted, so it is restarted. Returns "idle" if nothing was running.
   */
  interrupt(): "interrupted" | "restarted" | "idle" {
    if (this.state !== "running") return "idle";
    if (this.transport.interrupt()) return "interrupted";
    this.restart();
    return "restarted";
  }

  restart(kind = this.kind, python = this.python) {
    this.transport.stop();
    this.abandon();
    this.kind = kind;
    this.python = python;
    this.start();
  }

  private abandon() {
    for (const resolve of this.pending.values()) resolve(false);
    for (const resolve of this.samplers.values()) resolve([]);
    this.pending.clear();
    this.samplers.clear();
    this.running = 0;
  }
}
