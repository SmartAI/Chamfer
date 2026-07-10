import type { CadBootStatus, CadRequest, CadResponse } from "@chamfer/shared";

// Pyodide runtime version. Must match a Python ABI that OCP.wasm publishes
// wheels for (see packages/client/public/py/bootstrap.py header for the
// pinned OCP.wasm commit; PyPI has cp313 emscripten wheels for the Pyodide
// 0.29.x line and cp314 wheels for the 314.x line).
//
// Verified 2026-07-09 in real Chromium (Playwright): Pyodide 314.0.2 does
// NOT work here - its pyodide.js throws "Classic web workers are not
// supported" when loaded via importScripts in a classic worker (the 314.x
// loader dropped classic-worker support; the error surfaces as a generic
// importScripts NetworkError when loaded cross-origin from the CDN).
// Pyodide 0.29.4 (Python 3.13) loads and boots correctly in a classic
// worker and matches OCP.wasm's cp313 emscripten wheels.
const PYODIDE_VERSION = "0.29.4";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const BUILD123D_VERSION = "0.11.1";
const PACKAGE_CACHE_DIR = "/chamfer-cache";
const PACKAGE_CACHE_FILE = `${PACKAGE_CACHE_DIR}/cad-packages-${PYODIDE_VERSION}-${BUILD123D_VERSION}.zip`;

// Classic (non-module) worker: importScripts is only available here, and
// it lets us load pyodide.js directly from the CDN without bundling it.
// If Vite's worker pipeline ever forces `{ type: "module" }`, switch this
// file to `await import(/* @vite-ignore */ \`${PYODIDE_URL}pyodide.mjs\`)`
// instead of importScripts.
// (The project's tsconfig uses the DOM lib, not WebWorker, so the worker
// globals are declared narrowly here rather than pulling in the full
// WebWorker lib, which would conflict with DOM's own global declarations.)
declare const self: Worker & {
  importScripts: (...urls: string[]) => void;
  onmessage: ((e: MessageEvent<CadRequest>) => void) | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PyodideInterface = any;

// Eager boot: starts as soon as the worker is instantiated, per spec (boot
// on app load with a progress indicator, not on first run).
let pyodideReady: Promise<PyodideInterface> = boot();

function syncPersistentFs(pyodide: PyodideInterface, populate: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    pyodide.FS.syncfs(populate, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function mountPackageCache(pyodide: PyodideInterface): Promise<void> {
  pyodide.FS.mkdirTree(PACKAGE_CACHE_DIR);
  pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, PACKAGE_CACHE_DIR);
  await syncPersistentFs(pyodide, true);
}

async function restoreCachedPackages(pyodide: PyodideInterface): Promise<boolean> {
  pyodide.globals.set("_chamfer_package_cache", PACKAGE_CACHE_FILE);
  return Boolean(
    await pyodide.runPythonAsync(`
import os, site, zipfile

if os.path.isfile(_chamfer_package_cache):
    with zipfile.ZipFile(_chamfer_package_cache) as cache:
        cache.extractall(site.getsitepackages()[0])
    try:
        import build123d
        True
    except Exception:
        False
else:
    False
`),
  );
}

async function persistInstalledPackages(
  pyodide: PyodideInterface,
  originalEntries: string[],
): Promise<void> {
  pyodide.globals.set("_chamfer_original_site_entries", originalEntries);
  await pyodide.runPythonAsync(`
import os, site, zipfile

site_packages = site.getsitepackages()[0]
original = set(_chamfer_original_site_entries.to_py())
with zipfile.ZipFile(_chamfer_package_cache, "w", zipfile.ZIP_STORED) as cache:
    for entry in os.listdir(site_packages):
        if entry in original:
            continue
        path = os.path.join(site_packages, entry)
        if os.path.isdir(path):
            for root, _, files in os.walk(path):
                for filename in files:
                    full_path = os.path.join(root, filename)
                    cache.write(full_path, os.path.relpath(full_path, site_packages))
        else:
            cache.write(path, entry)
`);
  await syncPersistentFs(pyodide, false);
}

async function boot(): Promise<PyodideInterface> {
  try {
    post({ phase: "downloading", detail: "Pyodide runtime" } satisfies CadBootStatus);
    self.importScripts(`${PYODIDE_URL}pyodide.js`);
    const pyodide: PyodideInterface = await (
      self as unknown as { loadPyodide: (opts: { indexURL: string }) => Promise<PyodideInterface> }
    ).loadPyodide({ indexURL: PYODIDE_URL });

    post({
      phase: "installing",
      detail: "build123d + OpenCascade (first run downloads ~tens of MB)",
    } satisfies CadBootStatus);
    // bootstrap.py drives installs through micropip, which is an optional
    // Pyodide package that must be loaded explicitly before import.
    await pyodide.loadPackage("micropip");
    await mountPackageCache(pyodide);

    const restored = await restoreCachedPackages(pyodide);
    if (!restored) {
      const originalEntries = Array.from(
        await pyodide.runPythonAsync("import os, site; list(os.listdir(site.getsitepackages()[0]))"),
      ) as string[];
      const bootstrapSrc = await (await fetch("/py/bootstrap.py")).text();
      await pyodide.runPythonAsync(bootstrapSrc);
      // The PyPI path can leave only build123d's distribution metadata in
      // Pyodide. The GitHub source path installs the importable package.
      await pyodide.runPythonAsync(`await bootstrap('github:v${BUILD123D_VERSION}')`);
      await persistInstalledPackages(pyodide, originalEntries);
    }

    // Do not report Ready until the package users will import is proven to
    // exist. This also turns future bootstrap regressions into a boot error
    // instead of a misleading Ready state followed by a script traceback.
    await pyodide.runPythonAsync("import build123d");

    const harness = await (await fetch("/py/harness.py")).text();
    pyodide.FS.writeFile("/harness.py", harness);
    await pyodide.runPythonAsync("import sys; sys.path.insert(0, '/'); import harness");

    post({ phase: "ready" } satisfies CadBootStatus);
    return pyodide;
  } catch (err) {
    post({ phase: "error", detail: String(err) } satisfies CadBootStatus);
    throw err;
  }
}

function post(msg: unknown, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

self.onmessage = async (e: MessageEvent<CadRequest>) => {
  const req = e.data;
  try {
    const pyodide = await pyodideReady;
    if (req.cmd === "run") {
      const resultJson: string = await pyodide.runPythonAsync(
        `import harness, json; json.dumps(harness.run_script(${JSON.stringify(req.code)}))`,
      );
      const r = JSON.parse(resultJson);
      const positions = Float32Array.from(r.positions as number[]);
      const indices = Uint32Array.from(r.indices as number[]);
      const res: CadResponse = {
        id: req.id,
        ok: true,
        cmd: "run",
        stdout: r.stdout,
        measurements: r.measurements,
        mesh: { positions, indices },
        gate: r.gate,
      };
      post(res, [positions.buffer, indices.buffer]);
      return;
    }
    if (req.cmd === "parseParams") {
      const paramsJson: string = await pyodide.runPythonAsync(
        `import harness, json; json.dumps(harness.parse_params(${JSON.stringify(req.code)}))`,
      );
      const res: CadResponse = {
        id: req.id,
        ok: true,
        cmd: "parseParams",
        params: JSON.parse(paramsJson),
      };
      post(res);
      return;
    }
    if (req.cmd === "setParams") {
      // Values go through json.loads (double-stringified so the JSON text is
      // embedded as a Python string literal), mirroring the JSON round-trip
      // used elsewhere in this handler.
      const newCode: string = await pyodide.runPythonAsync(
        `import harness, json; harness.set_params(${JSON.stringify(req.code)}, json.loads(${JSON.stringify(JSON.stringify(req.values))}))`,
      );
      const res: CadResponse = { id: req.id, ok: true, cmd: "setParams", code: newCode };
      post(res);
      return;
    }
    if (req.cmd === "export") {
      // Python bytes come back as a PyProxy (no implicit conversion for
      // bytes). toJs() yields a Uint8Array view over the WASM heap, so copy
      // it into a fresh buffer before destroying the proxy and transferring.
      const proxy = await pyodide.runPythonAsync(
        `import harness; harness.export_model(${JSON.stringify(req.code)}, ${JSON.stringify(req.format)})`,
      );
      const view = proxy.toJs() as Uint8Array;
      const data = new Uint8Array(view);
      proxy.destroy();
      const res: CadResponse = {
        id: req.id,
        ok: true,
        cmd: "export",
        data,
        filename: `model.${req.format}`,
      };
      post(res, [data.buffer]);
      return;
    }
    // Every CadRequest cmd is handled above (req is narrowed to never here);
    // this fallback only fires on protocol drift at runtime.
    const unhandled = req as CadRequest;
    post({ id: unhandled.id, ok: false, cmd: unhandled.cmd, error: "not implemented" } satisfies CadResponse);
  } catch (err) {
    post({ id: req.id, ok: false, cmd: req.cmd, error: String(err) } satisfies CadResponse);
  }
};
