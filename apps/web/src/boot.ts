// Boot routing decision (pure, unit-tested): given auth state, the
// provider count (null while loading), wizard completion, and the
// current path, return the path to navigate to, or null to stay.

export interface BootState {
  mode: string;
  needsSetup: boolean;
  authenticated: boolean;
}

// Where to land after login when the user was bounced mid-route (e.g.
// a deep link to /stories/abc while logged out). sessionStorage so a
// reload mid-login keeps the target but a fresh tab does not inherit it.
export const LOGIN_REDIRECT_KEY = "opendungen.postLoginRedirect";

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveLoginRedirect(path: string): void {
  try {
    storage()?.setItem(LOGIN_REDIRECT_KEY, path);
  } catch {
    // Storage unavailable: the login simply lands on /.
  }
}

export function readLoginRedirect(): string | null {
  try {
    return storage()?.getItem(LOGIN_REDIRECT_KEY) ?? null;
  } catch {
    return null;
  }
}

export function clearLoginRedirect(): void {
  try {
    storage()?.removeItem(LOGIN_REDIRECT_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function bootTargetFor(
  state: BootState,
  providerCount: number | null,
  wizardDone: boolean,
  path: string,
  skipWizard: boolean,
  needsWizardNow: boolean,
  // Consumed when an authenticated user sits on an auth screen: they
  // return to where they were headed instead of /.
  postLoginRedirect?: string | null,
): string | null {
  if (state.needsSetup) {
    return path === "/setup" ? null : "/setup";
  }
  if (!state.authenticated) {
    return path === "/login" ? null : "/login";
  }
  // Authenticated from here on.
  if (path === "/setup" || path === "/login") {
    return postLoginRedirect ?? "/";
  }
  if (path.startsWith("/wizard/")) {
    // Stay mid-wizard even as the provider count changes underfoot
    // (saving the step-3 provider flips needsWizardNow off); only
    // bounce when the wizard is skipped outright.
    if (skipWizard) {
      return "/";
    }
    return null;
  }
  if (needsWizardNow) {
    return "/wizard/step-1";
  }
  // "/" renders the auto-resume view (views/home.tsx), which picks
  // the newest story or the empty state once stories load.
  return null;
}
