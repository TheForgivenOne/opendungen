import { request } from "./client";

export interface CompressedRange {
  id: string;
  startIdx: number;
  endIdx: number;
  summary: string;
  parentRangeId: string | null;
  createdAt: number;
  actionCount: number;
}

export function listRanges(storyId: string): Promise<{ ranges: CompressedRange[] }> {
  return request(`/api/stories/${storyId}/ranges`);
}

export function deleteRange(rangeId: string): Promise<{ ok: boolean }> {
  return request(`/api/ranges/${rangeId}`, { method: "DELETE" });
}
