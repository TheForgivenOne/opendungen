import { ApiError, post, request } from "./client";
import type { ActionMode, StoryAction } from "./stories";

export interface ContextUsage {
  required: number;
  cards: number;
  history: number;
  total: number;
}

export interface AppliedRange {
  id: string;
  startIdx: number;
  endIdx: number;
}

export interface GenerateMeta {
  usage: ContextUsage;
  cardsInjected: string[];
  rangesApplied: AppliedRange[];
  // Null on continue turns (no input action exists).
  inputActionId: string | null;
}

export interface ScriptErrorInfo {
  scriptId: string;
  name: string;
  message: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  source: "provider" | "estimated";
}

export interface StreamHandlers {
  onMeta(meta: GenerateMeta): void;
  onDelta(text: string): void;
  onDone(outputActionId: string, usage: TokenUsage): void;
  onError(code: string, message: string): void;
  onScriptErrors(errors: ScriptErrorInfo[]): void;
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data += line.slice("data:".length).trim();
    }
  }
  return event ? { event, data } : null;
}

async function streamTurn(
  path: string,
  body: unknown,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? "request_failed",
      err?.message ?? `request failed: ${res.status}`,
    );
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const handle = (block: string) => {
    const parsed = parseSseBlock(block);
    if (!parsed) {
      return;
    }
    const data = JSON.parse(parsed.data) as Record<string, never>;
    if (parsed.event === "meta") {
      handlers.onMeta(data as unknown as GenerateMeta);
    } else if (parsed.event === "delta") {
      handlers.onDelta((data as unknown as { text: string }).text);
    } else if (parsed.event === "done") {
      const done = data as unknown as { outputActionId: string; usage: TokenUsage };
      handlers.onDone(done.outputActionId, done.usage);
    } else if (parsed.event === "error") {
      const failed = data as unknown as { code: string; message: string };
      handlers.onError(failed.code, failed.message);
    } else if (parsed.event === "script_errors") {
      const failed = data as unknown as { errors: ScriptErrorInfo[] };
      handlers.onScriptErrors(failed.errors);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffered += decoder.decode(value, { stream: true });
    const blocks = buffered.split("\n\n");
    buffered = blocks.pop() ?? "";
    for (const block of blocks) {
      if (block.trim()) {
        handle(block);
      }
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) {
    handle(buffered);
  }
}

export function streamGenerate(
  storyId: string,
  input: string,
  handlers: StreamHandlers,
  signal: AbortSignal,
  restoreRangeIds?: string[],
  mode?: ActionMode,
): Promise<void> {
  const body: Record<string, unknown> = { input };
  if (restoreRangeIds?.length) {
    body.restoreRangeIds = restoreRangeIds;
  }
  if (mode) {
    body.mode = mode;
  }
  return streamTurn(`/api/stories/${storyId}/generate`, body, handlers, signal);
}

export function streamRetry(
  storyId: string,
  handlers: StreamHandlers,
  signal: AbortSignal,
  restoreRangeIds?: string[],
): Promise<void> {
  return streamTurn(
    `/api/stories/${storyId}/retry`,
    restoreRangeIds?.length ? { restoreRangeIds } : undefined,
    handlers,
    signal,
  );
}

// Continue: a real generation from context with no new
// input. Persists only the output action.
export function streamContinue(
  storyId: string,
  handlers: StreamHandlers,
  signal: AbortSignal,
  restoreRangeIds?: string[],
): Promise<void> {
  const body: Record<string, unknown> = { continue: true };
  if (restoreRangeIds?.length) {
    body.restoreRangeIds = restoreRangeIds;
  }
  return streamTurn(`/api/stories/${storyId}/generate`, body, handlers, signal);
}

export function undoTurn(storyId: string): Promise<{ deleted: number }> {
  return post(`/api/stories/${storyId}/undo`);
}

export function editAction(
  storyId: string,
  actionId: string,
  text: string,
): Promise<{ action: StoryAction }> {
  return request(`/api/stories/${storyId}/actions/${actionId}`, {
    method: "PATCH",
    body: JSON.stringify({ text }),
  });
}
