// OpenDungen story model. Original implementation, modeled on AI
// Dungeon's observable behavior. No AI Dungeon code or prompts copied.

export interface Action {
  id: string;
  storyId: string;
  index: number;              // monotonic position in the log
  type: "input" | "output" | "continue";
  text: string;
  createdAt: number;
}

export interface StoryCard {
  id: string;
  storyId: string;
  keys: string[];             // trigger keywords
  entry: string;              // injected when a key matches
  enabled: boolean;
}

export interface Story {
  id: string;
  userId: string;
  title: string;
  scenarioId: string | null;
  aiInstructions: string;
  plotEssentials: string;
  memory: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  opening: string;
  aiInstructions: string;
  tags: string[];
  builtin: boolean;
}

export interface CompressedRange {
  id: string;
  storyId: string;
  startIdx: number;
  endIdx: number;
  summary: string;
  parentRangeId: string | null;  // nesting, DCP-style
  createdAt: number;
}

export interface ContextBudget {
  totalTokens: number;       // default 8192
  requiredCapPct: number;    // default 0.70
  dynamicSplit: { cards: number; history: number; memory: number };
  compressTriggerPct: number; // default 0.60
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  totalTokens: 8192,
  requiredCapPct: 0.70,
  dynamicSplit: { cards: 0.25, history: 0.50, memory: 0.25 },
  compressTriggerPct: 0.60,
};

export const DEFAULT_MAX_OUTPUT_TOKENS = 400;
export const HISTORY_KEEP_LAST_N = 3;   // never compressed
