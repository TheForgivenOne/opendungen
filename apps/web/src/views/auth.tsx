// Setup + login screens. On success they refresh the auth-state query;
// the boot gate in main.tsx routes to the wizard or the app.

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { login, setup } from "../api/auth";
import { errorMessage } from "../api/client";
import { buttonClass, cardClass, ErrorText, inputClass } from "../ui";

export function SetupScreen() {
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("passwords do not match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setup(email, password);
      await client.invalidateQueries({ queryKey: ["auth-state"] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-4 text-text">
      <form onSubmit={(e) => void submit(e)} className={cardClass}>
        <h1 className="mb-1 text-xl font-bold">OpenDungen setup</h1>
        <p className="mb-4 text-sm text-text-muted">Create the instance admin account.</p>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              className={inputClass}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Password
            <input
              className={inputClass}
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Confirm password
            <input
              className={inputClass}
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <ErrorText error={error} />
          <button className={buttonClass} disabled={busy}>
            {busy ? "Creating…" : "Create admin"}
          </button>
        </div>
      </form>
    </main>
  );
}

export function LoginScreen() {
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      await client.invalidateQueries({ queryKey: ["auth-state"] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-4 text-text">
      <form onSubmit={(e) => void submit(e)} className={cardClass}>
        <h1 className="mb-1 text-xl font-bold">OpenDungen login</h1>
        <p className="mb-4 text-sm text-text-muted">Sign in to your stories.</p>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              className={inputClass}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Password
            <input
              className={inputClass}
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <ErrorText error={error} />
          <button className={buttonClass} disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </main>
  );
}
