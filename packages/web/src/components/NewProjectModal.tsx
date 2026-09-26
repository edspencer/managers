import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Project, ProjectStatus } from "../lib/types";
import { AREAS } from "../lib/areas";
import { XIcon } from "./icons";

const STATUSES: ProjectStatus[] = ["idea", "active", "paused", "blocked", "done"];

/**
 * Managers M3: projects are notebooks. A GitHub repo is recorded as metadata (a
 * link), never cloned. Accepts `owner/name`, or a pasted github.com URL, and
 * returns the canonical `owner/name` — or `null` when it is neither.
 */
export function parseGithubRepo(input: string): string | null {
  const t = input
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(t);
  if (!m || m[2] === "." || m[2] === "..") return null;
  return `${m[1]}/${m[2]}`;
}

export function NewProjectModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (p: Project) => void;
}) {
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [domain, setDomain] = useState("");
  const [group, setGroup] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [github, setGithub] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form ONLY on an open transition. Deliberately keyed on `open`
  // alone: folding `busy` in here (as an earlier version did) re-ran the reset on
  // every Create click — the `finally { setBusy(false) }` toggle then wiped the
  // just-set error, so a failed create (e.g. an invalid repo URL, issue #187)
  // silently blanked the form with no message.
  useEffect(() => {
    if (open) {
      setName("");
      setSummary("");
      setDomain("");
      setGroup("");
      setStatus("active");
      setGithub("");
      setError(null);
    }
  }, [open]);

  // Escape-to-close (ignored while a create is in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const githubRepo = github.trim() ? parseGithubRepo(github) : null;
    if (github.trim() && !githubRepo) {
      setError("GitHub repo must look like owner/name (or a github.com URL).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject({
        name: name.trim(),
        status,
        group: group || undefined,
        summary: summary.trim() || undefined,
        // Notebook only (Managers M3): no `repo`/`path`, so the server creates a
        // managed notes project. The repo is a link, not a checkout.
        links: githubRepo
          ? [{ label: "GitHub", url: `https://github.com/${githubRepo}` }]
          : undefined,
        domain: domain
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
      });
      onCreated(project);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create project");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <form
        className="w-full max-w-md animate-scale-in rounded-2xl border border-edge bg-surface-raised p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">New project</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg-muted"
            aria-label="Close"
          >
            <XIcon width={18} height={18} />
          </button>
        </div>

        <label className="mb-4 block">
          <span className="field-label">Name</span>
          <input
            autoFocus
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Garage Water Heater Replacement"
          />
        </label>

        <label className="mb-4 block">
          <span className="field-label">Summary (optional)</span>
          <input
            className="input"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="One line on what this project is about"
          />
        </label>

        <label className="mb-4 block">
          <span className="field-label">Area</span>
          <select className="input" value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">Unsorted</option>
            {AREAS.map((a) => (
              <option key={a.slug} value={a.slug}>
                {a.label}
              </option>
            ))}
          </select>
        </label>

        {/* Managers M3: projects are notebooks — Managers never clones or links
            code. The directory / clone-URL options upstream offered here are
            hidden (the server still accepts them); a repo is metadata only. */}
        <label className="mb-4 block">
          <span className="field-label">GitHub repo (optional)</span>
          <input
            className="input"
            value={github}
            onChange={(e) => setGithub(e.target.value)}
            placeholder="owner/name"
            aria-describedby="new-project-github-help"
          />
          <span id="new-project-github-help" className="mt-1 block text-xs text-fg-subtle">
            Recorded as a link on the project. Nothing is cloned — the manager works from
            notes, not source.
          </span>
        </label>

        <div className="mb-5 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="field-label">Domain tags</span>
            <input
              className="input"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="home, plumbing"
            />
          </label>
          <label className="block">
            <span className="field-label">Status</span>
            <select
              className="input capitalize"
              value={status}
              onChange={(e) => setStatus(e.target.value as ProjectStatus)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s} className="capitalize">
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && (
          <p className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create project"}
          </button>
        </div>
      </form>
    </div>
  );
}
