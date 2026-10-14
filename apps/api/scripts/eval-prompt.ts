// Prompt eval runner (reading tool — not CI).
// For each case in eval-cases.json: builds the context with the real
// assembler, drains one non-streamed provider call (temperature 0.8,
// maxTokens from the case), and writes the output for human review.
// No database, no real story, no persistence of any kind.
//
// Provider selection is environment-only:
//   EVAL_PROVIDER_KIND  openai | anthropic | ollama | openai-compatible (default ollama)
//   EVAL_BASE_URL       provider base URL (default http://localhost:11434)
//   EVAL_MODEL          model id (default llama3.2)
//   EVAL_API_KEY        API key (default empty — local Ollama)
//   EVAL_TEMPERATURE    override the 0.8 default (debugging only)
//
// Usage: pnpm --filter api eval-prompt
// Output: apps/api/scripts/eval-output/<timestamp>/<case>.txt + summary.md

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleContext, type AssembleAction } from "../src/context/assemble.js";
import { AnthropicProvider } from "../src/llm/anthropic-provider.js";
import { OllamaProvider } from "../src/llm/ollama-provider.js";
import { OpenAICompatibleProvider } from "../src/llm/openai-compatible-provider.js";
import { OpenAIProvider } from "../src/llm/openai-provider.js";
import {
  isProviderKind,
  providerErrorMessage,
  type LLMMessage,
  type LLMProvider,
} from "../src/llm/types.js";

const here = dirname(fileURLToPath(import.meta.url));

interface EvalHistoryTurn {
  type: string;
  text: string;
}

interface EvalCase {
  name: string;
  scenarioId: string;
  scenarioInstructions: string;
  summary?: string;
  memory?: string;
  cards?: { entry: string; keys?: string[] }[];
  history: EvalHistoryTurn[];
  input?: string;
  mode: "do" | "say" | "story" | "continue";
  maxTokens: number;
}

function buildProvider(): LLMProvider {
  const kindRaw = process.env["EVAL_PROVIDER_KIND"] ?? "ollama";
  if (!isProviderKind(kindRaw)) {
    throw new Error(`EVAL_PROVIDER_KIND must be one of openai|anthropic|ollama|openai-compatible`);
  }
  const config = {
    kind: kindRaw,
    baseUrl: process.env["EVAL_BASE_URL"] ?? "http://localhost:11434",
    model: process.env["EVAL_MODEL"] ?? "llama3.2",
    apiKey: process.env["EVAL_API_KEY"] ?? "",
  };
  switch (kindRaw) {
    case "openai":
      return new OpenAIProvider(config);
    case "anthropic":
      return new AnthropicProvider(config);
    case "ollama":
      return new OllamaProvider(config);
    case "openai-compatible":
      return new OpenAICompatibleProvider(config);
  }
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

async function runCase(
  provider: LLMProvider,
  temperature: number,
  c: EvalCase,
): Promise<{ output: string; messages: LLMMessage[]; words: number }> {
  const actions: AssembleAction[] = c.history.map((h, i) => ({
    idx: i,
    type: h.type,
    text: h.text,
  }));
  const assembled = assembleContext({
    story: {
      aiInstructions: c.scenarioInstructions,
      plotEssentials: "",
      summary: c.summary ?? "",
      memory: c.memory ?? "",
    },
    actions,
    cards: (c.cards ?? []).map((card, i) => ({
      id: `eval-${i}`,
      keys: card.keys ?? [],
      entry: card.entry,
      enabled: true,
    })),
    mode: c.mode,
    newInput: c.mode === "continue" ? undefined : (c.input ?? ""),
    tokenMultiplier: provider.tokenMultiplier,
    maxOutputTokens: c.maxTokens,
    ranges: [],
  });
  // Same single-system fallback as the pipeline: providers that
  // reject multiple system messages get every system block joined.
  let messages = assembled.messages;
  if (!provider.supportsMultipleSystemMessages) {
    const blocks = messages.filter((m) => m.role === "system");
    messages = [
      { role: "system", content: blocks.map((m) => m.content).join("\n\n") },
      ...messages.filter((m) => m.role !== "system"),
    ];
  }
  let output = "";
  const stream = provider.complete(
    { messages, maxTokens: c.maxTokens, temperature },
    new AbortController().signal,
  );
  for await (const chunk of stream) {
    output += chunk.delta;
  }
  return { output, messages, words: countWords(output) };
}

const cases = JSON.parse(readFileSync(join(here, "eval-cases.json"), "utf8")) as {
  cases: EvalCase[];
};
const provider = buildProvider();
const temperature = Number(process.env["EVAL_TEMPERATURE"] ?? "0.8");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(here, "eval-output", stamp);
mkdirSync(outDir, { recursive: true });

let failures = 0;
const summary: string[] = [
  `# Prompt eval — ${stamp}`,
  ``,
  `Provider: ${process.env["EVAL_PROVIDER_KIND"] ?? "ollama"} / ${process.env["EVAL_MODEL"] ?? "llama3.2"} @ ${process.env["EVAL_BASE_URL"] ?? "http://localhost:11434"}, temperature ${temperature}.`,
  ``,
];
for (const c of cases.cases) {
  try {
    const { output, words } = await runCase(provider, temperature, c);
    const lines = [
      `# ${c.name} (mode=${c.mode}${c.input !== undefined ? `, input=${JSON.stringify(c.input)}` : ""})`,
      ``,
      output.trimEnd(),
      ``,
      `--- ${words} words${c.name === "length_check" && words > 200 ? " — OVER 200 WORDS" : ""}`,
      ``,
    ];
    writeFileSync(join(outDir, `${c.name}.txt`), lines.join("\n"));
    summary.push(`## ${c.name} (mode=${c.mode}, ${words} words)`, ``, output.trimEnd(), ``);
    console.log(`${c.name}: ${words} words`);
  } catch (err) {
    failures += 1;
    const message = `EVAL FAILED: ${providerErrorMessage(err)}`;
    writeFileSync(join(outDir, `${c.name}.txt`), `${message}\n`);
    summary.push(`## ${c.name} — FAILED`, ``, message, ``);
    console.log(`${c.name}: FAILED (${providerErrorMessage(err)})`);
  }
}
writeFileSync(join(outDir, "summary.md"), summary.join("\n"));
console.log(`wrote ${outDir}/summary.md`);
if (failures > 0) {
  process.exit(1);
}
