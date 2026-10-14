import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FROZEN_PATHS = [
  "packages/shared/src/story.ts",
  "apps/api/src/context/prompts.ts",
];

const APPEND_ONLY_DIRS = [
  "apps/api/drizzle/",
];

const DANGEROUS_BASH = [
  "rm -rf",
  "git push",
  "git reset --hard",
  "git clean -fd",
  "wrangler secret put",
  "wrangler d1 delete",
  "pnpm deploy",
  "npm publish",
  "pnpm publish",
];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = (event.input?.file_path ?? event.input?.path ?? "")
        .toString()
        .replace(/^\.\//, "");

      for (const frozen of FROZEN_PATHS) {
        if (path === frozen || path.endsWith("/" + frozen)) {
          const ok = await ctx.ui.confirm(
            "Frozen file",
            `${frozen} is a frozen contract. Editing it requires explicit approval. Proceed?`,
          );
          if (!ok) {
            return {
              block: true,
              reason: `${frozen} is frozen. See AGENTS.md §7.`,
            };
          }
        }
      }

      for (const dir of APPEND_ONLY_DIRS) {
        if (path.startsWith(dir) && !path.endsWith(".gitkeep")) {
          return {
            block: true,
            reason: `${dir} contains applied migrations. Create a NEW migration; never edit an existing one.`,
          };
        }
      }
    }

    if (event.toolName === "bash") {
      const cmd = (event.input?.command ?? "").toString();

      for (const frag of DANGEROUS_BASH) {
        if (cmd.includes(frag)) {
          const ok = await ctx.ui.confirm(
            "Dangerous command",
            `Command contains "${frag}". Allow?\n\n${cmd}`,
          );
          if (!ok) {
            return { block: true, reason: `User denied: ${frag}` };
          }
        }
      }

      if (/\bgit\s+add\s+\./.test(cmd)) {
        ctx.ui.notify(
          "Reminder: confirm .dev.vars and *.sqlite are gitignored before this commit.",
          "warning",
        );
      }
    }

    return undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const { execSync } = await import("node:child_process");
      const status = execSync("git status --short", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      if (status.length > 0) {
        const lines = status.split("\n").length;
        ctx.ui.notify(
          `Working tree is dirty (${lines} file${lines === 1 ? "" : "s"}). Commit or stash before starting a phase.`,
          "warning",
        );
      }
    } catch {
      // Not a git repo, or git unavailable. Silent.
    }
  });
}
