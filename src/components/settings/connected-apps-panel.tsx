"use client";

import { useEffect, useState } from "react";

import type { OAuthGrantSummary } from "@/lib/oauth-authorization";

// The apps this person has allowed to act as them through "Allow access"
// (OAuth 2.0 authorization code flow). Taking one back ends every sign-in
// it holds for them at once.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export function ConnectedAppsPanel() {
  const endpoint = "/api/account/oauth-grants";
  const [grants, setGrants] = useState<OAuthGrantSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
          grants?: OAuthGrantSummary[];
        } | null;

        if (cancelled) {
          return;
        }

        if (!response.ok || !payload?.grants) {
          setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
          return;
        }

        setGrants(payload.grants);
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

  async function takeBack(grant: OAuthGrantSummary) {
    setPendingId(grant.oauthClientId);
    setError(null);

    try {
      const response = await fetch(
        `${endpoint}/${encodeURIComponent(grant.oauthClientId)}`,
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

  // Nothing to show until someone has allowed an app, so a person who never
  // does is not given a panel about it.
  if (grants !== null && grants.length === 0 && !error) {
    return null;
  }

  return (
    <div className="panel space-y-5 p-6 sm:p-8">
      <div className="space-y-2">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          Connected apps
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Apps you allowed to act as you. Take access back and the app stops
          working for you at once; it has to ask you again.
        </p>
      </div>

      {error ? (
        <p className="notice notice-danger max-w-2xl" role="alert">
          {error}
        </p>
      ) : null}

      {grants === null ? null : (
        <ul aria-label="Connected apps" className="grid max-w-2xl gap-3">
          {grants.map((grant) => (
            <li className="well grid gap-2 p-4" key={grant.oauthClientId}>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[0.9375rem] font-bold text-(--fg)">
                  {grant.name}
                </p>
                <span className="pill pill-neutral">
                  {grant.scope === "write" ? "Read and write" : "Read only"}
                </span>
              </div>
              <p className="text-sm text-(--secondary)">
                Made by {grant.ownerName}. Allowed on{" "}
                {dateFormatter.format(new Date(grant.authorizedAt * 1000))}.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {revokingId === grant.oauthClientId ? (
                  <>
                    <span className="text-sm text-(--secondary)">
                      Take back access? The app stops working for you at once.
                    </span>
                    <button
                      className="btn-quiet btn-quiet-danger"
                      disabled={pendingId !== null}
                      onClick={() => void takeBack(grant)}
                      type="button"
                    >
                      {pendingId === grant.oauthClientId
                        ? "Taking back..."
                        : "Take back"}
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
                    aria-label={`Take back access from ${grant.name}`}
                    className="btn-quiet btn-quiet-danger"
                    disabled={pendingId !== null}
                    onClick={() => setRevokingId(grant.oauthClientId)}
                    type="button"
                  >
                    Take back access
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
