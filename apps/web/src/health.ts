export interface Health {
  ok: boolean;
  service: string;
}

export function formatHealth(health: Health): string {
  return `${health.service}: ${health.ok ? "ok" : "not ok"}`;
}
