// Request validation: one zod schema per write body, plus the shared
// invalidRequest formatter. Handlers stay thin; the schemas read as
// the API's contract.

import type { Context } from "hono";
import { z } from "zod";
import { apiError } from "./http";

// Formats zod failures as { error: { code: "validation_error", message } }.
export function invalidRequest(result: { success: boolean; error?: unknown }, c: Context) {
  if (!result.success) {
    const issues = (
      result.error as
        { issues?: { path: (string | number | symbol)[]; message: string }[] } | undefined
    )?.issues;
    const message =
      issues?.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") ??
      "invalid request body";
    return c.json(apiError("validation_error", message), 400);
  }
}

// Deliberately lenient: must look like a mailbox (local@domain.tld)
// without rejecting short-but-valid forms such as a@b.c.
export const emailSchema = z
  .string()
  .min(3)
  .max(320)
  .refine((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), {
    message: "Invalid email address",
  });
export const passwordSchema = z.string().min(8).max(256);
export const credentialsSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const createStorySchema = z.object({
  title: z.string().min(1).max(200),
  scenarioId: z.string().min(1).max(128).optional(),
});

export const patchStorySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    aiInstructions: z.string().max(20000).optional(),
    plotEssentials: z.string().max(20000).optional(),
    memory: z.string().max(20000).optional(),
    // Persistent provider override; null clears it.
    providerId: z.string().min(1).max(128).nullable().optional(),
    // Nullable per-story overrides, validated to sane ranges.
    // Null clears back to the shared constants.
    compressTriggerPct: z.number().min(0.3).max(0.95).nullable().optional(),
    compressMaxTokens: z.number().int().min(200).max(2000).nullable().optional(),
    compressTemperature: z.number().min(0).max(1).nullable().optional(),
    contextTokens: z.number().int().min(2048).max(200000).nullable().optional(),
    maxOutputTokens: z.number().int().min(100).max(4000).nullable().optional(),
    // Completion marker; a unix-ms timestamp or null.
    completedAt: z.number().int().min(1).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: "at least one field is required",
  });

export const appendActionSchema = z.object({
  type: z.enum(["input", "output", "continue"]),
  text: z.string().min(1).max(50000),
  mode: z.enum(["do", "say", "story"]).optional(),
});

export const keysSchema = z.array(z.string().min(1).max(200)).min(1).max(50);

export const createCardSchema = z.object({
  keys: keysSchema,
  entry: z.string().min(1).max(20000),
  enabled: z.boolean().optional(),
});

export const patchCardSchema = z
  .object({
    keys: keysSchema.optional(),
    entry: z.string().min(1).max(20000).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: "at least one field is required",
  });
