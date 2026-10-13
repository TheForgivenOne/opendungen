// Settings: instance, account, data, danger zone.

import { useRef, useState } from "react";
import { errorMessage } from "../api/client";
import { logoutAll } from "../api/auth";
import { runMaintenance, type MaintenanceResult } from "../api/settings";
import {
  downloadExportAll,
  importBackup,
  previewBackup,
  type ImportPreview,
  type ImportSummary,
} from "../api/import-export";
import { navigate } from "../location";
import { PageHeader } from "../shell";
import { queryClient, useAccountSettings, useInstanceSettings } from "../queries";
import { useToast } from "../toast";
import { ErrorText, Modal, Skeleton, buttonClass, ghostClass, inputClass } from "../ui";

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function SettingsScreen() {
  const toast = useToast();
  const instanceQuery = useInstanceSettings();
  const accountQuery = useAccountSettings();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [maintenance, setMaintenance] = useState<MaintenanceResult | null>(null);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);

  async function runMaintenanceNow() {
    if (maintenanceBusy) {
      return;
    }
    setMaintenanceBusy(true);
    setMaintenanceError(null);
    try {
      setMaintenance(await runMaintenance());
      toast.push("success", "Maintenance complete.");
    } catch (err) {
      setMaintenanceError(errorMessage(err));
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function exportAll() {
    try {
      await downloadExportAll();
    } catch (err) {
      toast.push("error", errorMessage(err));
    }
  }

  async function pickFile(file: File | null) {
    if (!file) {
      return;
    }
    setPreviewFile(file);
    setSummary(null);
    setPreviewError(null);
    setConfirmText("");
    setMode("merge");
    try {
      setPreview(await previewBackup(file));
    } catch (err) {
      setPreview({ stories: 0, actions: 0, cards: 0, scripts: 0, warnings: [] });
      setPreviewError(errorMessage(err));
    }
    if (fileRef.current) {
      fileRef.current.value = "";
    }
  }

  function closeImport() {
    setPreview(null);
    setPreviewFile(null);
    setSummary(null);
    setPreviewError(null);
  }

  async function runImport() {
    if (!previewFile || busy) {
      return;
    }
    setBusy(true);
    setPreviewError(null);
    try {
      const result = await importBackup(previewFile, mode, confirmText === "DELETE");
      setSummary(result);
      await queryClient.invalidateQueries();
      toast.push("success", "Import complete.");
    } catch (err) {
      setPreviewError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function signOutEverywhere() {
    if (!window.confirm("Sign out on all devices? This deletes every session.")) {
      return;
    }
    try {
      await logoutAll();
      queryClient.clear();
      navigate("/login");
    } catch (err) {
      toast.push("error", errorMessage(err));
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-4">
      <PageHeader title="Settings" />

      <section className="rounded border border-border bg-surface p-4">
        <h2 className="mb-2 font-bold">Instance</h2>
        {instanceQuery.isPending ? (
          <Skeleton lines={2} />
        ) : instanceQuery.isError ? (
          <ErrorText error={errorMessage(instanceQuery.error)} />
        ) : (
          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Auth mode</dt>
              <dd>{instanceQuery.data.authMode}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Version</dt>
              <dd>{instanceQuery.data.version}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Session secret set</dt>
              <dd>{instanceQuery.data.hasSessionSecret ? "yes" : "no"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Setup complete</dt>
              <dd>{instanceQuery.data.setupComplete ? "yes" : "no"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Rate limiting</dt>
              <dd>{instanceQuery.data.rateLimitEnabled ? "enabled" : "disabled"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">SSRF protection</dt>
              <dd>{instanceQuery.data.allowPrivateProviderUrls ? "disabled" : "enabled"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Log level</dt>
              <dd>{instanceQuery.data.logLevel}</dd>
            </div>
          </dl>
        )}
        {!accountQuery.isPending &&
          !accountQuery.isError &&
          accountQuery.data.user.instanceAdmin && (
            <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3 text-sm">
              {maintenanceError && <ErrorText error={maintenanceError} />}
              <div>
                <button
                  className={ghostClass}
                  disabled={maintenanceBusy}
                  onClick={() => void runMaintenanceNow()}
                >
                  Run maintenance now
                </button>
              </div>
              {maintenance && (
                <p className="text-text-muted">
                  Deleted {maintenance.deleted.sessions} sessions, {maintenance.deleted.rateLimits}{" "}
                  rate limits, {maintenance.deleted.scriptStates} script states,{" "}
                  {maintenance.deleted.compressedRanges} bad ranges.
                </p>
              )}
            </div>
          )}
      </section>

      <section className="rounded border border-border bg-surface p-4">
        <h2 className="mb-2 font-bold">Account</h2>
        {accountQuery.isPending ? (
          <Skeleton lines={2} />
        ) : accountQuery.isError ? (
          <ErrorText error={errorMessage(accountQuery.error)} />
        ) : (
          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Email</dt>
              <dd>{accountQuery.data.user.email ?? "Anonymous"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Instance admin</dt>
              <dd>{accountQuery.data.user.instanceAdmin ? "yes" : "no"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Created</dt>
              <dd>{formatDate(accountQuery.data.user.createdAt)}</dd>
            </div>
          </dl>
        )}
      </section>

      <section className="rounded border border-border bg-surface p-4">
        <h2 className="mb-2 font-bold">Data</h2>
        {accountQuery.isPending ? (
          <Skeleton lines={2} />
        ) : accountQuery.isError ? (
          <ErrorText error={errorMessage(accountQuery.error)} />
        ) : (
          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Stories</dt>
              <dd>{accountQuery.data.counts.stories}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Actions</dt>
              <dd>{accountQuery.data.counts.actions}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-muted">Compressed ranges</dt>
              <dd>{accountQuery.data.counts.ranges}</dd>
            </div>
          </dl>
        )}
      </section>

      <section className="rounded border border-danger/50 bg-surface p-4">
        <h2 className="mb-2 font-bold text-danger">Danger zone</h2>
        <div className="flex flex-wrap gap-2">
          <button className={buttonClass} onClick={() => void exportAll()}>
            Export all stories as JSON
          </button>
          <button className={ghostClass} onClick={() => fileRef.current?.click()}>
            Import
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Import file"
            onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
          />
          <button className={ghostClass} onClick={() => void signOutEverywhere()}>
            Sign out everywhere
          </button>
        </div>
      </section>
      {preview && (
        <Modal title="Import backup" onClose={closeImport}>
          <div className="flex flex-col gap-3 text-sm">
            {previewError && <ErrorText error={previewError} />}
            <ul>
              <li>Stories: {preview.stories}</li>
              <li>Actions: {preview.actions}</li>
              <li>Cards: {preview.cards}</li>
              <li>Scripts: {preview.scripts}</li>
            </ul>
            {preview.warnings.map((warning) => (
              <p key={warning} className="text-text-muted">
                Warning: {warning}
              </p>
            ))}
            <p className="text-text-muted">
              Merge adds everything as new rows. Replace deletes all of your data first.
            </p>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="import-mode"
                  checked={mode === "merge"}
                  onChange={() => setMode("merge")}
                />
                Merge
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="import-mode"
                  checked={mode === "replace"}
                  onChange={() => setMode("replace")}
                />
                Replace
              </label>
            </div>
            {mode === "replace" && (
              <label className="flex flex-col gap-1">
                Type DELETE to confirm replacement
                <input
                  className={inputClass}
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="DELETE"
                />
              </label>
            )}
            {summary && (
              <div>
                <p>
                  Imported {summary.imported.stories ?? 0} stories, {summary.imported.actions ?? 0}{" "}
                  actions.
                </p>
                {summary.skipped.length > 0 && (
                  <ul className="mt-1 flex flex-col gap-1 text-text-muted">
                    {summary.skipped.map((skip, i) => (
                      <li key={`${skip.entity}-${i}`}>
                        Skipped {skip.entity}: {skip.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="flex gap-2">
              {!summary && (
                <button
                  className={buttonClass}
                  disabled={busy || (mode === "replace" && confirmText !== "DELETE")}
                  onClick={() => void runImport()}
                >
                  Import
                </button>
              )}
              <button className={ghostClass} onClick={closeImport}>
                {summary ? "Close" : "Cancel"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
