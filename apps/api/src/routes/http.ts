// Error-shape helper: every failure answers
// { error: { code, message } } (the request id is injected by
// middleware, so handlers never add it themselves).

export function apiError(code: string, message: string) {
  return { error: { code, message } };
}
