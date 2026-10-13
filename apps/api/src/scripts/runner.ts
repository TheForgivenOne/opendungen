// QuickJS sandbox for user scripts. One runtime per hook invocation;
// never reused across requests. The sandbox exposes exactly:
//   state, text (input/output hooks), context (context hook),
//   log(msg), history (last 10 actions, frozen).
// No fetch, require, import, timers, console, process, or Date.
// Math.random is replaced with a deterministic PRNG seeded per hook
// call so runs are reproducible.

import {
  checkContextFields,
  createSandbox,
  describeFailure,
  readGlobal,
  setJsonGlobal,
  unwrapEval,
} from "./sandbox";
import {
  DEFAULT_HOOK_MEMORY_BYTES,
  DEFAULT_HOOK_TIMEOUT_MS,
  MAX_STATE_BYTES,
  type ContextPayload,
  type InputPayload,
  type RunHookOptions,
  type ScriptErrorInfo,
  type ScriptResult,
} from "./types";

export async function runHook<T>(opts: RunHookOptions<T>): Promise<ScriptResult<T>> {
  const hook = opts.hook;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const memoryLimitBytes = opts.memoryLimitBytes ?? DEFAULT_HOOK_MEMORY_BYTES;
  const logger = opts.logger ?? ((message: string) => console.debug(message));
  const seed = opts.seed ?? `${hook}:default`;

  const errors: ScriptErrorInfo[] = [];
  const updatedStates = new Map<string, string>();
  let text: unknown = hook === "context" ? undefined : (opts.payload as InputPayload).text;
  let contextFields: ContextPayload | null =
    hook === "context" ? { ...(opts.payload as ContextPayload) } : null;

  const { sandbox, done } = await createSandbox({
    seed,
    timeoutMs,
    memoryLimitBytes,
    history: opts.history ?? [],
    logger,
  });
  const { ctx } = sandbox;
  try {
    for (const script of opts.scripts) {
      sandbox.setScriptName(script.name);
      try {
        // Per-script state, deep-cloned in.
        const prior = opts.states.get(script.id) ?? {};
        const priorJson = JSON.stringify(prior) ?? "{}";
        setJsonGlobal(ctx, "state", priorJson);

        // Current payload values.
        if (hook === "context" && contextFields) {
          setJsonGlobal(ctx, "text", "undefined");
          setJsonGlobal(ctx, "context", JSON.stringify(contextFields));
        } else {
          setJsonGlobal(ctx, "text", JSON.stringify(text));
          setJsonGlobal(ctx, "context", "undefined");
        }

        const outcome = unwrapEval(ctx, script.source);
        if (outcome.error !== undefined) {
          errors.push({
            scriptId: script.id,
            name: script.name,
            message: describeFailure(sandbox.timedOut(), timeoutMs, outcome.error),
          });
          continue;
        }

        // Read back what the script may have mutated.
        if (hook === "context" && contextFields) {
          const checked = checkContextFields(readGlobal(ctx, "context"));
          if (typeof checked === "string") {
            errors.push({ scriptId: script.id, name: script.name, message: checked });
            continue;
          }
          contextFields = checked;
        } else {
          const nextText = readGlobal(ctx, "text");
          if (typeof nextText !== "string") {
            errors.push({
              scriptId: script.id,
              name: script.name,
              message: "text must remain a string",
            });
            continue;
          }
          text = nextText;
        }

        // State round-trip with a 64 KB cap; oversize keeps old state.
        const nextState = readGlobal(ctx, "state");
        let nextJson: string;
        try {
          nextJson = JSON.stringify(nextState) ?? "{}";
        } catch {
          errors.push({
            scriptId: script.id,
            name: script.name,
            message: "state must be JSON-serializable",
          });
          continue;
        }
        if (new TextEncoder().encode(nextJson).length > MAX_STATE_BYTES) {
          errors.push({
            scriptId: script.id,
            name: script.name,
            message: `state exceeds ${MAX_STATE_BYTES / 1024} KB cap; old state kept`,
          });
          continue;
        }
        if (nextJson !== priorJson) {
          updatedStates.set(script.id, nextJson);
          opts.states.set(script.id, JSON.parse(nextJson) as unknown);
        }
      } catch (err) {
        errors.push({
          scriptId: script.id,
          name: script.name,
          message:
            err instanceof Error
              ? describeFailure(sandbox.timedOut(), timeoutMs, err.message)
              : "script error",
        });
      }
    }
  } finally {
    done();
  }

  if (hook === "context" && contextFields) {
    return { value: contextFields as T, errors, updatedStates };
  }
  return { value: { text } as T, errors, updatedStates };
}

// Validates a script without running a turn: executes it once in a fresh
// runtime with dummy globals (both text and an empty context, so input
// and context scripts both validate) and a 100ms budget. Any throw —
// syntax or top-level — is a validation failure.
export async function validateScript(
  source: string,
  timeoutMs = 100,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { sandbox, done } = await createSandbox({
    seed: "validate",
    timeoutMs,
    memoryLimitBytes: DEFAULT_HOOK_MEMORY_BYTES,
    history: [],
    logger: () => {},
  });
  const { ctx } = sandbox;
  try {
    sandbox.setScriptName("validate");
    setJsonGlobal(ctx, "state", "{}");
    setJsonGlobal(ctx, "text", JSON.stringify(""));
    setJsonGlobal(
      ctx,
      "context",
      JSON.stringify({ instructions: "", plotEssentials: "", summary: "", memory: "", cards: [] }),
    );
    const outcome = unwrapEval(ctx, source);
    if (outcome.error !== undefined) {
      return { ok: false, error: describeFailure(sandbox.timedOut(), timeoutMs, outcome.error) };
    }
    return { ok: true };
  } finally {
    done();
  }
}
