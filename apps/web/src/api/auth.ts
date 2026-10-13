import { post, request } from "./client";

export interface User {
  id: string;
  email: string | null;
  instanceAdmin: boolean;
}

export interface AuthState {
  mode: string;
  needsSetup: boolean;
  authenticated: boolean;
}

export function getState(): Promise<AuthState> {
  return request<AuthState>("/api/auth/state");
}

export function setup(email: string, password: string): Promise<{ user: User }> {
  return post("/api/auth/setup", { email, password });
}

export function login(email: string, password: string): Promise<{ user: User }> {
  return post("/api/auth/login", { email, password });
}

export function logout(): Promise<{ ok: boolean }> {
  return post("/api/auth/logout");
}

export function logoutAll(): Promise<{ ok: boolean }> {
  return post("/api/auth/logout-all");
}

export function getMe(): Promise<{ user: User }> {
  return request("/api/auth/me");
}
