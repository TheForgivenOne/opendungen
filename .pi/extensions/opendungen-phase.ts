import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, _ctx) => {
    const prompt = (event.prompt ?? "").toString().toLowerCase();

    const looksLikePhase =
      prompt.startsWith("/phase") ||
      prompt.includes("next phase") ||
      prompt.includes("start a phase") ||
      prompt.startsWith("phase ");

    if (!looksLikePhase) return undefined;

    return {
      systemPrompt:
        (event.systemPrompt ?? "") +
        "\n\n## Phase protocol reminder\n" +
        "You are starting a phase. Do ALL of the following before editing any file:\n" +
        "1. Read PROGRESS.md, docs/ARCHITECTURE.md, docs/STRUCTURE.md, docs/TECH_DEBT.md.\n" +
        "2. Restate the task in 2-4 lines.\n" +
        "3. Write a plan with steps and verification.\n" +
        "4. Create a phase branch: git checkout -b phase-<letter>-<slug>.\n" +
        "5. STOP and wait for approval.\n" +
        "Do not skip step 5.",
    };
  });

  pi.on("agent_end", async (_event, ctx) => {
    try {
      const { execSync } = await import("node:child_process");
      const status = execSync("git status --short", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      if (status.length === 0) return;

      const lines = status.split("\n");
      const touchedSource = lines.some((l) => /apps\/|packages\//.test(l));

      if (touchedSource) {
        ctx.ui.notify(
          `Source files changed but uncommitted (${lines.length} file${lines.length === 1 ? "" : "s"}). Commit at the next logical breakpoint.`,
          "info",
        );
      }
    } catch {
      // Not a git repo. Silent.
    }
  });
}
