import { request } from "./client";

export interface InstanceSettings {
  authMode: string;
  version: string;
  hasSessionSecret: boolean;
  setupComplete: boolean;
  rateLimitEnabled: boolean;
  allowPrivateProviderUrls: boolean;
  logLevel: string;
}

export interface MaintenanceResult {
  deleted: {
    sessions: number;
    rateLimits: number;
    scriptStates: number;
    compressedRanges: number;
  };
}

export function runMaintenance(): Promise<MaintenanceResult> {
  return request("/api/admin/cleanup", { method: "POST" });
}

export interface AccountSettings {
  user: {
    id: string;
    email: string | null;
    instanceAdmin: boolean;
    createdAt: number;
  };
  counts: {
    stories: number;
    actions: number;
    ranges: number;
  };
}

export function getInstanceSettings(): Promise<InstanceSettings> {
  return request("/api/settings/instance");
}

export function getAccountSettings(): Promise<AccountSettings> {
  return request("/api/settings/account");
}
