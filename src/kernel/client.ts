import type { FromKernel, Series, ToKernel, View } from "./protocol";
import KernelWorker from "./worker?worker";

export type KernelState = "booting" | "idle" | "running" | "dead";

type Listener = (msg: FromKernel) => void;

/** Owns the Python worker. Stopping a run means restarting the worker. */
export class Kernel {
  private worker!: Worker;
  private nextId = 1;
  private nextReq = 1;
  private pending = new Map<number, (ok: boolean) => void>();
  private samplers = new Map<number, (series: Series[]) => void>();
  private running = 0;
  state: KernelState = "booting";

  constructor(
    private onMessage: Listener,
    private onState: (s: KernelState, detail?: string) => void,
  ) {
    this.start();
  }

  private start() {
    this.setState("booting", "booting");
    this.worker = new KernelWorker();
    this.worker.onmessage = (ev: MessageEvent<FromKernel>) => this.handle(ev.data);
    this.worker.onerror = (ev) => {
      this.setState("dead", "crashed");
      this.onMessage({ type: "fatal", text: ev.message || "kernel crashed" });
    };
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
        this.setState(this.running ? "running" : "idle", `python ${msg.python}`);
        break;
      case "fatal":
        this.setState("dead", "failed to start");
        break;
      case "done":
        this.running--;
        this.pending.get(msg.id)?.(msg.ok);
        this.pending.delete(msg.id);
        if (this.running === 0 && this.state === "running") this.setState("idle", "idle");
        break;
      case "samples":
        this.samplers.get(msg.reqId)?.(msg.series);
        this.samplers.delete(msg.reqId);
        return;
    }
    this.onMessage(msg);
  }

  private send(msg: ToKernel) {
    this.worker.postMessage(msg);
  }

  run(code: string): { id: number; done: Promise<boolean> } {
    const id = this.nextId++;
    const done = new Promise<boolean>((resolve) => this.pending.set(id, resolve));
    this.running++;
    if (this.state === "idle") this.setState("running", "running");
    this.send({ type: "run", id, code });
    return { id, done };
  }

  sample(ids: string[], view: Required<{ [K in keyof View]: number }>, n: number): Promise<Series[]> {
    const reqId = this.nextReq++;
    return new Promise((resolve) => {
      this.samplers.set(reqId, resolve);
      this.send({ type: "sample", reqId, ids, view, n });
    });
  }

  /** Kill the worker (aborting any run) and boot a fresh interpreter. */
  restart() {
    this.worker.terminate();
    for (const resolve of this.pending.values()) resolve(false);
    for (const resolve of this.samplers.values()) resolve([]);
    this.pending.clear();
    this.samplers.clear();
    this.running = 0;
    this.start();
  }
}
