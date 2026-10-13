// Vitest-only stand-in for ./emscripten-module.wasm (see qjs-module.ts).
// Wrangler bundles .wasm imports as WebAssembly.Module; vitest/vite-node
// cannot, so the vitest config aliases the import here. Node compiles the
// vendored bytes synchronously — same module, same semantics.
import { readFileSync } from "node:fs";

const bytes = readFileSync(new URL("./emscripten-module.wasm", import.meta.url));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
// The WebAssembly namespace has no value declaration under this
// tsconfig, so reach the host constructor structurally.
interface WasmModuleConstructor {
  new (bytes: ArrayBuffer): object;
}
const HostWebAssembly = (
  globalThis as unknown as { WebAssembly: { Module: WasmModuleConstructor } }
).WebAssembly;
const mod = new HostWebAssembly.Module(buffer as ArrayBuffer);
export default mod;
