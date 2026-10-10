/// <reference lib="webworker" />
import type { PyodideAPI } from "pyodide";
import prelude from "./prelude.py?raw";
import type { FromKernel, ToKernel } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const indexURL = new URL("/pyodide/", self.location.href).href;
const post = (msg: FromKernel) => self.postMessage(msg);

let currentId = 0;
let py: PyodideAPI;

// Every request goes through one queue so runs and resamples never interleave.
let queue: Promise<unknown> = Promise.resolve();
const enqueue = (job: () => Promise<unknown>) => (queue = queue.then(job, job));

async function boot() {
  const t0 = performance.now();
  post({ type: "status", text: "loading python runtime" });
  const { loadPyodide } = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
  py = (await loadPyodide({ indexURL })) as PyodideAPI;

  py.setStdout({ batched: (text: string) => post({ type: "stdout", id: currentId, text }) });
  py.setStderr({ batched: (text: string) => post({ type: "stderr", id: currentId, text }) });
  py.registerJsModule("calx_js", {
    emit(kind: string, json: string) {
      const payload = JSON.parse(json);
      if (kind === "plot") post({ type: "plot", id: currentId, plot: payload });
      else post({ type: kind, id: currentId, ...payload } as FromKernel);
    },
  });

  post({ type: "status", text: "loading sympy" });
  await py.loadPackage(["sympy"], { messageCallback: () => {} });
  post({ type: "status", text: "starting kernel" });
  await py.runPythonAsync(prelude);

  const python = py.runPython("import sys; sys.version.split()[0]") as string;
  post({ type: "ready", version: py.version, python, ms: performance.now() - t0 });
}

async function run(id: number, code: string) {
  currentId = id;
  const t0 = performance.now();
  let ok = false;
  try {
    await py.loadPackagesFromImports(code, {
      messageCallback: (m: string) => {
        if (m.startsWith("Loading") || m.startsWith("Loaded")) post({ type: "status", text: m.toLowerCase() });
      },
      errorCallback: (m: string) => post({ type: "stderr", id, text: m }),
    });
    const runner = py.globals.get("_run");
    ok = await runner(code);
    runner.destroy();
  } catch (e) {
    post({ type: "error", id, text: String((e as Error).message ?? e) });
  }
  post({ type: "done", id, ok, ms: performance.now() - t0 });
}

function sample(msg: Extract<ToKernel, { type: "sample" }>) {
  const fn = py.globals.get("_resample");
  try {
    const out = fn(JSON.stringify(msg)) as string;
    post({ type: "samples", reqId: msg.reqId, series: JSON.parse(out) });
  } finally {
    fn.destroy();
  }
}

const ready = boot().catch((e) => {
  post({ type: "fatal", text: String((e as Error)?.stack ?? e) });
  throw e;
});

self.onmessage = (ev: MessageEvent<ToKernel>) => {
  const msg = ev.data;
  enqueue(async () => {
    await ready;
    if (msg.type === "run") await run(msg.id, msg.code);
    else if (msg.type === "sample") sample(msg);
  });
};
