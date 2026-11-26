"use client";

import { useEffect, useState } from "react";

import type { OAuthClientSummary } from "@/lib/oauth";

// OAuth 2.0 clients for the public API (/api/v1), for apps that fetch
// short-lived access tokens instead of keeping a long-lived key. The secret
// is shown once, right after the client is made, and never again.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function formatDate(seconds: number | null) {
  return seconds === null
    ? null
    : dateFormatter.format(new Date(seconds * 1000));
}

export function OAuthClientsPanel() {
  const endpoint = "/api/account/oauth-clients";
  const [clients, setClients] = useState<OAuthClientSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("write");
  const [isCreating, setIsCreating] = useState(false);
  const [created, setCreated] = useState<{
    clientId: string;
    clientSecret: string;
    name: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        const payload = (await response.json().catch(() => null)) as {
          clients?: OAuthClientSummary[];
          error?: string;
        } | null;

        if (cancelled) {
          return;
        }

        if (!response.ok || !payload?.clients) {
          setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
          return;
        }

        setClients(payload.clients);
      } catch {
        if (!cancelled) {
          setError(GENERIC_ERROR_MESSAGE);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [revision]);

  async function createClient() {
    if (created) {
      return;
    }

    setIsCreating(true);
    setError(null);
    setCopied(false);

    try {
      const response = await fetch(endpoint, {
        body: JSON.stringify({ name, scope }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        clientSecret?: string;
        error?: string;
        summary?: OAuthClientSummary;
      } | null;

      if (!response.ok || !payload?.clientSecret || !payload.summary) {
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      setCreated({
        clientId: payload.summary.clientId,
        clientSecret: payload.clientSecret,
        name: payload.summary.name,
      });
      setName("");
      setRevision((value) => value + 1);
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setIsCreating(false);
    }
  }

  async function revokeClient(client: OAuthClientSummary) {
    setPendingId(client.id);
    setError(null);

    try {
      const response = await fetch(
        `${endpoint}/${encodeURIComponent(client.id)}`,
        { method: "DELETE" },
      );
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;

      if (!response.ok) {
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      setRevokingId(null);
      setRevision((value) => value + 1);
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setPendingId(null);
    }
  }

  async function copySecret() {
    if (!created) {
      return;
    }

    try {
      await navigator.clipboard.writeText(created.clientSecret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="panel space-y-5 p-6 sm:p-8">
      <div className="space-y-2">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          My OAuth clients
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          For apps that sign in to the API with OAuth 2.0 (client credentials).
          The app trades its client id and secret at{" "}
          <code className="font-mono">/api/oauth/token</code> for an access
          token that lasts an hour. A client acts as you, like an API key. Keep
          the secret in the app&apos;s secret settings, never in a browser, and
          revoke the client as soon as it may have leaked.
        </p>
      </div>

      <div className="grid max-w-xl gap-4 sm:grid-cols-3">
        <label className="grid gap-1.5 sm:col-span-3">
          <span className="text-[0.8125rem] font-semibold text-(--secondary)">
            Name
          </span>
          <input
            autoComplete="off"
            className="field-input"
            disabled={isCreating}
            maxLength={80}
            name="oauth-client-name"
            onChange={(event) => setName(event.target.value)}
            placeholder="For example: Billing app"
            value={name}
          />
        </label>
        <label className="grid gap-1.5 sm:col-span-2">
          <span className="text-[0.8125rem] font-semibold text-(--secondary)">
            Access
          </span>
          <select
            className="field-input"
            disabled={isCreating}
            name="oauth-client-scope"
            onChange={(event) =>
              setScope(event.target.value === "read" ? "read" : "write")
            }
            value={scope}
          >
            <option value="write">Read and write</option>
            <option value="read">Read only</option>
          </select>
        </label>
        <div className="flex items-end">
          <button
            className="btn-quiet min-h-12 w-full px-5 text-sm"
            disabled={
              isCreating || created !== null || name.trim().length === 0
            }
            onClick={() => void createClient()}
            type="button"
          >
            {isCreating ? "Creating..." : "Create client"}
          </button>
        </div>
      </div>

      {created ? (
        <div
          className="well grid max-w-2xl gap-3 p-4"
          data-testid="new-oauth-client"
          role="status"
        >
          <p className="text-sm font-semibold text-(--fg)">
            Copy the secret for {created.name} now. It is not shown again.
          </p>
          <p className="text-sm text-(--secondary)">Client id</p>
          <code className="block overflow-x-auto rounded-lg border border-(--border) bg-(--paper) px-3 py-2 font-mono text-sm break-all text-(--fg)">
            {created.clientId}
          </code>
          <p className="text-sm text-(--secondary)">Client secret</p>
          <code className="block overflow-x-auto rounded-lg border border-(--border) bg-(--paper) px-3 py-2 font-mono text-sm break-all text-(--fg)">
            {created.clientSecret}
          </code>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-quiet"
              onClick={() => void copySecret()}
              type="button"
            >
              {copied ? "Copied" : "Copy secret"}
            </button>
            <button
              className="btn-quiet"
              onClick={() => setCreated(null)}
              type="button"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="notice notice-danger max-w-2xl" role="alert">
          {error}
        </p>
      ) : null}

      {clients === null ? null : clients.length === 0 ? (
        <p className="text-sm text-(--secondary)">No OAuth clients yet.</p>
      ) : (
        <ul aria-label="OAuth clients" className="grid max-w-2xl gap-3">
          {clients.map((client) => {
            const revoked = client.revokedAt !== null;
            const lastUsed = formatDate(client.lastUsedAt);

            return (
              <li className="well grid gap-2 p-4" key={client.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[0.9375rem] font-bold text-(--fg)">
                    {client.name}
                  </p>
                  <span
                    className={`pill ${revoked ? "pill-neutral" : client.ownerClosing ? "pill-warning" : "pill-success"}`}
                  >
                    {revoked
                      ? "Revoked"
                      : client.ownerClosing
                        ? "Stopped"
                        : "Active"}
                  </span>
                  <span className="pill pill-neutral">
                    {client.scope === "write" ? "Read and write" : "Read only"}
                  </span>
                </div>
                <p className="font-mono text-sm break-all text-(--secondary)">
                  {client.clientId}
                </p>
                <p className="text-sm text-(--secondary)">
                  Made on {formatDate(client.createdAt)}.{" "}
                  {lastUsed ? `Last used ${lastUsed}.` : "Not used yet."}
                </p>
                {revoked ? null : (
                  <div className="flex flex-wrap items-center gap-2">
                    {revokingId === client.id ? (
                      <>
                        <span className="text-sm text-(--secondary)">
                          Revoke this client? Apps using it stop working at
                          once.
                        </span>
                        <button
                          className="btn-quiet btn-quiet-danger"
                          disabled={pendingId !== null}
                          onClick={() => void revokeClient(client)}
                          type="button"
                        >
                          {pendingId === client.id ? "Revoking..." : "Revoke"}
                        </button>
                        <button
                          className="btn-quiet"
                          disabled={pendingId !== null}
                          onClick={() => setRevokingId(null)}
                          type="button"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        aria-label={`Revoke ${client.name}`}
                        className="btn-quiet btn-quiet-danger"
                        disabled={pendingId !== null}
                        onClick={() => setRevokingId(client.id)}
                        type="button"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
