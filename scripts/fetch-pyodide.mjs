// Prepares public/pyodide/: copies the Pyodide runtime from node_modules and
// downloads the wheels calx needs so the app works offline. Packages that are
// not bundled keep an absolute CDN URL in the lock file and load on demand.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pyodide");
const out = join(root, "public", "pyodide");

const BUNDLED = (process.env.CALX_BUNDLE ?? "sympy,numpy,matplotlib").split(",").filter(Boolean);
const CORE = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip"];

const pkg = JSON.parse(await readFile(join(src, "package.json"), "utf8"));
const CDN = `https://cdn.jsdelivr.net/pyodide/v${pkg.version}/full/`;

const exists = (p) => stat(p).then(() => true, () => false);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

await mkdir(out, { recursive: true });
for (const f of CORE) await copyFile(join(src, f), join(out, f));

const lock = JSON.parse(await readFile(join(src, "pyodide-lock.json"), "utf8"));
const packages = lock.packages;

// Dependency closure of the bundled packages.
const wanted = new Set();
const visit = (name) => {
  if (wanted.has(name) || !packages[name]) return;
  wanted.add(name);
  for (const d of packages[name].depends ?? []) visit(d);
};
BUNDLED.forEach(visit);

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// Pure-Python wheels are also published on PyPI; use it when the CDN is unreachable.
async function fromPyPI(entry) {
  if (!entry.file_name.endsWith("-none-any.whl")) return null;
  const meta = await (await fetch(`https://pypi.org/pypi/${entry.name}/${entry.version}/json`)).json();
  const file = meta.urls?.find((u) => u.filename === entry.file_name)
    ?? meta.urls?.find((u) => u.filename.endsWith("-none-any.whl"));
  return file ? download(file.url) : null;
}

const missing = [];
for (const [name, entry] of Object.entries(packages)) {
  if (!wanted.has(name)) {
    entry.file_name = CDN + entry.file_name;
    continue;
  }
  const dest = join(out, entry.file_name);
  if (await exists(dest) && sha256(await readFile(dest)) === entry.sha256) continue;
  let buf = null;
  try {
    buf = await download(CDN + entry.file_name);
  } catch {
    buf = await fromPyPI(entry).catch(() => null);
  }
  if (!buf) {
    missing.push(name);
    entry.file_name = CDN + entry.file_name;
    continue;
  }
  entry.sha256 = sha256(buf);
  await writeFile(dest, buf);
  console.log(`  bundled ${entry.file_name} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

await writeFile(join(out, "pyodide-lock.json"), JSON.stringify(lock));
console.log(`pyodide ${pkg.version} ready in public/pyodide (${wanted.size - missing.length}/${wanted.size} packages bundled)`);
if (missing.length) console.warn(`  not bundled, will load from CDN at runtime: ${missing.join(", ")}`);
