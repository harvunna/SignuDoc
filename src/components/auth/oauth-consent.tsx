"use client";

import { useState } from "react";

// The screen that asks a signed-in person whether an app may act as them.
// The answer goes to /api/oauth/authorize, which checks everything again;
// nothing here is trusted.

type ConsentParams = {
  client_id: string;
  code_challenge: string;
  code_challenge_method: "S256";
  redirect_uri: string;
  response_type: "code";
  scope: "read" | "write";
  state: string | null;
};

type OAuthConsentProps = {
  appName: string;
  email: string;
  ownerName: string;
  params: ConsentParams;
  /** The site the person is sent back to, so they can see where it goes. */
  returnsTo: string;
  scope: "read" | "write";
};

export function OAuthConsent({
  appName,
  email,
  ownerName,
  params,
  returnsTo,
  scope,
}: OAuthConsentProps) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function answer(decision: "allow" | "deny") {
    if (busy) {
      return;
    }

    setBusy(decision);
    setError(null);

    try {
      const response = await fetch("/api/oauth/authorize", {
        body: JSON.stringify({ ...params, decision }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        redirectTo?: string;
      } | null;

      if (!response.ok || !payload?.redirectTo) {
        setError(payload?.error ?? "Something went wrong. Please try again.");
        setBusy(null);
        return;
      }

      window.location.assign(payload.redirectTo);
    } catch {
      setError("Something went wrong. Please try again.");
      setBusy(null);
    }
  }

  return (
    <section className="panel w-full max-w-[460px] space-y-5 p-8 sm:p-10">
      <div className="space-y-2">
        <h1 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          Allow {appName}?
        </h1>
        <p className="text-sm leading-6 text-(--secondary)">
          {appName}, made by {ownerName}, is asking to use your account ({email}
          ).
        </p>
      </div>

      <div className="well space-y-2 p-4 text-sm leading-6 text-(--fg)">
        <p className="font-semibold">It will be able to:</p>
        <ul className="list-disc space-y-1 pl-5 text-(--secondary)">
          <li>See your envelopes, templates and who signed them</li>
          {scope === "write" ? (
            <li>Create, send, remind and void envelopes in your name</li>
          ) : null}
        </ul>
        <p className="text-(--secondary)">
          It will not see your password and cannot change your sign-in settings.
        </p>
      </div>

      <p className="text-xs leading-5 text-(--secondary)">
        If you allow it, you go back to <strong>{returnsTo}</strong>. You can
        take access back any time under Settings, Connected apps.
      </p>

      {error ? (
        <p className="notice notice-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button
          className="btn btn-primary"
          disabled={busy !== null}
          onClick={() => void answer("allow")}
          type="button"
        >
          {busy === "allow" ? "Allowing..." : "Allow"}
        </button>
        <button
          className="btn-quiet"
          disabled={busy !== null}
          onClick={() => void answer("deny")}
          type="button"
        >
          {busy === "deny" ? "Cancelling..." : "Cancel"}
        </button>
      </div>
    </section>
  );
}
