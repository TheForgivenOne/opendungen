// Post-build fixup for the Node entry point (used by `build:node`).
// tsc emits the repo's extensionless relative imports verbatim
// (`from "./app"`), which Cloudflare Workers, Vite, and vitest all
// resolve — but plain Node ESM requires an explicit extension. This
// rewrites extensionless relative specifiers in dist/**/*.js to add
// `.js`, leaving already-suffixed imports (../package.json,
// ./emscripten-module.wasm) untouched.

import { existsSync, statSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.name.endsWith(".js")) {
      yield full;
    }
  }
}

// Matches `from "./x"` / `from '../x'` and `import("./x")` where x has
// no file extension.
const IMPORT_RE = /(from\s*|import\()\s*(["'])(\.{1,2}\/[^"']*)\2/g;

let changed = 0;
for await (const file of walk(dist)) {
  const source = await readFile(file, "utf8");
  const fixed = source.replace(IMPORT_RE, (match, prefix, quote, spec) => {
    // JSON needs an import attribute under plain Node ESM (Workers
    // and Vite resolve it attributeless; the source stays as-is).
    if (spec.endsWith(".json")) {
      if (prefix.trimStart().startsWith("from")) {
        changed++;
        return `${prefix}${quote}${spec}${quote} with { type: "json" }`;
      }
      return match;
    }
    // Dotted names that are NOT module suffixes (./db.local,
    // ./foo.test) still need .js appended for plain Node ESM.
    if (/\.(js|mjs|cjs|wasm|ts|tsx|node)$/.test(spec)) {
      return match;
    }
    // Directory imports (./llm) resolve to their index module.
    let resolved = `${spec}.js`;
    try {
      const target = join(dirname(file), spec);
      if (existsSync(target) && statSync(target).isDirectory()) {
        resolved = `${spec}/index.js`;
      }
    } catch {
      // Unresolvable here — leave the .js guess in place.
    }
    changed++;
    return `${prefix}${quote}${resolved}${quote}`;
  });
  if (fixed !== source) {
    await writeFile(file, fixed);
  }
}
console.log(`fix-dist-imports: rewrote ${changed} specifiers`);
