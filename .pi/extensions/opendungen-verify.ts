import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(exec);

async function runStep(
  label: string,
  cmd: string,
  ctx: { ui: { notify: (m: string, t?: string) => void } },
): Promise<{ label: string; ok: boolean; output: string }> {
  ctx.ui.notify(`verify: ${label}…`, "info");
  try {
    const { stdout, stderr } = await run(cmd, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return { label, ok: true, output: (stdout + stderr).trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      label,
      ok: false,
      output: (e.stdout ?? "") + (e.stderr ?? "") || (e.message ?? "failed"),
    };
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("verify", {
    description: "Run the full OpenDungen verification suite",
    handler: async (_args, ctx) => {
      const steps: Array<[string, string]> = [
        ["typecheck", "pnpm -r typecheck"],
        ["lint", "pnpm -r lint"],
        ["format", "pnpm -r format"],
        ["test", "pnpm -r test"],
        ["build", "pnpm -r build"],
      ];

      const results = [];
      for (const [label, cmd] of steps) {
        results.push(await runStep(label, cmd, ctx));
      }

      const failed = results.filter((r) => !r.ok);
      const summary = results
        .map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.label}`)
        .join("\n");

      const testResult = results.find((r) => r.label === "test");
      let counts = "";
      if (testResult?.ok) {
        const matches = testResult.output.match(/(\d+)\s+passed/g);
        if (matches) counts = `\nTest pass lines: ${matches.join(", ")}`;
      }

      if (failed.length === 0) {
        ctx.ui.notify(`All green.\n${summary}${counts}`, "info");
      } else {
        const detail = failed
          .map((r) => `--- ${r.label} ---\n${r.output.slice(0, 2000)}`)
          .join("\n\n");
        ctx.ui.notify(
          `${failed.length} step(s) failed.\n${summary}${counts}\n\n${detail}`,
          "error",
        );
      }
    },
  });
}
