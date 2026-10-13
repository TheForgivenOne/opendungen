// Ambient shim for better-sqlite3: only the surface used by db.local.ts.
// Kept in a .d.ts so the Cloudflare Worker bundle never includes Node
// native modules (db.local.ts is only imported by tests/Node tooling).
declare module "better-sqlite3" {
  // Minimal surface: db.local.ts only constructs and hands the handle
  // to drizzle (whose own types name this same module for its client
  // type); the real library provides the full API at runtime.
  class Database {
    constructor(filename?: string);
  }
  export default Database;
}

// Wrangler bundles relative .wasm imports as WebAssembly.Module.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
