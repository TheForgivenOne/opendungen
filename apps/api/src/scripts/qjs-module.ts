// QuickJS module singleton built from a pre-compiled WebAssembly.Module.
//
// Per the quickjs-emscripten docs (Packaging → WebAssembly loading), URL
// fetching of the .wasm file is forbidden in Cloudflare Workers, so the
// sanctioned pattern is `newVariant(base, { wasmModule })` with the .wasm
// imported as a module: wrangler compiles it at bundle time and the
// isolate never compiles code at runtime. The .wasm file is vendored
// from @jitl/quickjs-wasmfile-release-sync (the RELEASE_SYNC bytes).
//
// The import is dynamic so the module loads on first script execution
// only: stories without scripts never touch the WASM bytes. The
// instantiation is cached in module scope.

import {
  newQuickJSWASMModule,
  newVariant,
  RELEASE_SYNC,
  type QuickJSWASMModule,
} from "quickjs-emscripten";

let cached: Promise<QuickJSWASMModule> | null = null;

export function getSandboxQuickJS(): Promise<QuickJSWASMModule> {
  if (!cached) {
    cached = loadSandboxModule();
  }
  return cached;
}

// WebAssembly reached through globalThis (same pattern as
// qjs-wasm.vitest.ts): the tsconfig lib has no DOM WebAssembly value,
// so the namespace cannot be referenced directly (TS2708).
interface HostWasm {
  Module: new (bytes: ArrayBuffer) => object;
  compile(bytes: ArrayBuffer | Uint8Array): Promise<object>;
}
const HostWebAssembly = (globalThis as unknown as { WebAssembly: HostWasm }).WebAssembly;

async function loadSandboxModule(): Promise<QuickJSWASMModule> {
  // Plain Node ESM cannot import .wasm as a compiled Module the way
  // bundlers do (the import itself rejects) — compile the vendored
  // bytes directly instead. The node: imports are dynamic so the
  // Workers bundle stays intact; this branch never executes there
  // (the bundle-time Module always satisfies the check below), nor in
  // vitest (same-realm Module via the config alias).
  let wasmModule: unknown = null;
  try {
    const mod = await import("./emscripten-module.wasm");
    const candidate = (mod as { default: unknown }).default;
    if (candidate instanceof HostWebAssembly.Module) {
      wasmModule = candidate;
    }
  } catch {
    wasmModule = null;
  }
  if (wasmModule === null) {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const bytes = await readFile(
      fileURLToPath(new URL("./emscripten-module.wasm", import.meta.url)),
    );
    wasmModule = await HostWebAssembly.compile(bytes);
  }
  return newQuickJSWASMModule(
    newVariant(RELEASE_SYNC, { wasmModule: wasmModule as WebAssembly.Module }),
  );
}
