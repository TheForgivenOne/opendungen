import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

// Maps the vendored QuickJS .wasm import (a WebAssembly.Module under
// wrangler) to a Node-side shim that compiles the same bytes. Only the
// module loading differs; all sandbox semantics are identical.
export default defineConfig({
  test: {
    alias: [
      {
        find: "./emscripten-module.wasm",
        replacement: resolve(here, "src", "scripts", "qjs-wasm.vitest.ts"),
      },
    ],
  },
});
