// App entry: providers (location, theme, toasts, react-query), boot
// gate (auth-state → setup/login/wizard/app routing), shell + views.

import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { errorMessage } from "./api/client";
import "./index.css";
import { LocationProvider, navigate, useLocation, viewPath } from "./location";
import { bootTargetFor, clearLoginRedirect, readLoginRedirect, saveLoginRedirect } from "./boot";
import { queryClient, useAuthState, useProviders } from "./queries";
import { Shell } from "./shell";
import { ThemeProvider } from "./theme";
import { ToastProvider } from "./toast";
import { buttonClass } from "./ui";
import { LoginScreen, SetupScreen } from "./views/auth";
import { HomeScreen } from "./views/home";
import { ProvidersScreen } from "./views/providers/ProvidersScreen";
import { ScenarioScreen } from "./views/scenarios/ScenarioScreen";
import { ScenariosScreen } from "./views/scenarios/ScenariosScreen";
import { NewScenarioNameScreen, NewScenarioScreen } from "./views/scenarios/NewStoryFlow";
import { SettingsScreen } from "./views/settings";
import { StoriesScreen } from "./views/stories";
import { StoryScreen } from "./views/story";
import { WizardScreen, needsWizard, readWizardDone, shouldSkipWizard } from "./views/wizard";

export function BootGate() {
  const view = useLocation();
  const authQuery = useAuthState();
  const state = authQuery.data ?? null;
  const providersQuery = useProviders(state !== null && state.authenticated && !state.needsSetup);
  const providerCount = providersQuery.data ? providersQuery.data.providers.length : null;
  const path = view.name === "not-found" ? window.location.pathname : viewPath(view);

  useEffect(() => {
    if (!state) {
      return;
    }
    // Wait for the provider list before deciding about the wizard.
    if (state.authenticated && !state.needsSetup && providerCount === null) {
      return;
    }
    const done = readWizardDone();
    // Deep links survive login: stash the app path we bounce away
    // from, and consume it when an authenticated user lands on /login.
    let redirect: string | null = null;
    if (!state.authenticated && !state.needsSetup) {
      if (path !== "/login" && path !== "/setup" && !path.startsWith("/wizard/")) {
        saveLoginRedirect(path);
      }
    } else if (state.authenticated && (path === "/login" || path === "/setup")) {
      redirect = readLoginRedirect();
    }
    const target = bootTargetFor(
      state,
      providerCount,
      done,
      path,
      shouldSkipWizard(state.mode, providerCount ?? 0, done),
      needsWizard(true, providerCount, done),
      redirect,
    );
    if (target && target !== path) {
      if (redirect && target === redirect) {
        clearLoginRedirect();
      }
      navigate(target);
    }
  }, [state, providerCount, path]);

  if (authQuery.isPending) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-bg text-text">
        <p>loading…</p>
      </main>
    );
  }

  if (authQuery.isError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-bg p-4 text-text">
        <div className="text-center">
          <p className="mb-2">Cannot reach the API: {errorMessage(authQuery.error)}</p>
          <button className={buttonClass} onClick={() => void authQuery.refetch()}>
            Retry
          </button>
        </div>
      </main>
    );
  }

  function loading() {
    return (
      <main className="flex min-h-screen items-center justify-center bg-bg text-text">
        <p>loading…</p>
      </main>
    );
  }

  // Render-gating mirrors the effect below: app views (which fetch on
  // mount) never render until routing is settled, so their queries
  // cannot 401 and race the redirect.
  if (!state) {
    return loading();
  }
  const inWizard = view.name === "wizard";
  const inAuth = view.name === "setup" || view.name === "login";
  if (state.needsSetup) {
    return view.name === "setup" ? <SetupScreen /> : loading();
  }
  if (!state.authenticated) {
    return view.name === "login" ? <LoginScreen /> : loading();
  }
  if (providerCount === null) {
    return loading();
  }
  const done = readWizardDone();
  const skip = shouldSkipWizard(state.mode, providerCount, done);
  const need = needsWizard(true, providerCount, done);
  // In-wizard loading only when skipping (the effect bounces away);
  // a mid-wizard provider save flips need off but must keep rendering.
  if (inAuth || (need && !skip && !inWizard) || (skip && inWizard)) {
    return loading();
  }

  // Setup/login render in the gating above; reaching here they are
  // excluded by narrowing, so the switch covers the app views only.
  switch (view.name) {
    case "home":
      return (
        <Shell>
          <HomeScreen />
        </Shell>
      );
    case "wizard":
      return <WizardScreen step={view.step} />;
    case "stories":
      return (
        <Shell>
          <StoriesScreen />
        </Shell>
      );
    case "story":
      return (
        <Shell>
          <StoryScreen key={view.id} id={view.id} />
        </Shell>
      );
    case "scenarios":
      return (
        <Shell>
          <ScenariosScreen />
        </Shell>
      );
    case "scenario-new":
      return (
        <Shell>
          <NewScenarioScreen />
        </Shell>
      );
    case "scenario-new-name":
      return (
        <Shell>
          <NewScenarioNameScreen />
        </Shell>
      );
    case "scenario":
      return (
        <Shell>
          <ScenarioScreen id={view.id} />
        </Shell>
      );
    case "providers":
      return (
        <Shell>
          <ProvidersScreen />
        </Shell>
      );
    case "settings":
      return (
        <Shell>
          <SettingsScreen />
        </Shell>
      );
    case "not-found":
      return (
        <Shell>
          <main className="mx-auto w-full max-w-xl p-4">
            <h1 className="mb-2 text-xl font-bold">Not found</h1>
            <p className="text-text-muted">That page does not exist.</p>
          </main>
        </Shell>
      );
  }
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root element");
}
createRoot(root).render(
  <StrictMode>
    <LocationProvider>
      <ThemeProvider>
        <ToastProvider>
          <QueryClientProvider client={queryClient}>
            <BootGate />
          </QueryClientProvider>
        </ToastProvider>
      </ThemeProvider>
    </LocationProvider>
  </StrictMode>,
);
