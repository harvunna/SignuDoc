import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { OAuthConsent } from "@/components/auth/oauth-consent";
import { getAuthSession } from "@/lib/auth/server";
import {
  buildRedirect,
  parseAuthorizeRequest,
} from "@/lib/oauth-authorization";
import { getSettings } from "@/lib/settings";
import { needsTwoFactorSetup } from "@/lib/sign-in-security";

// The page an app sends someone to, to ask them to let it use their GCM eSign
// account (OAuth 2.0 authorization code flow). Someone not signed in is sent
// to sign in and comes back here. See docs/api.md.

export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { follow: false, index: false },
  title: "Allow access",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AuthorizePage({ searchParams }: PageProps) {
  const params = await searchParams;
  // A name given twice is ambiguous, so it counts as not given.
  const read = (name: string) => {
    const value = params[name];

    return typeof value === "string" ? value : null;
  };
  const session = await getAuthSession();

  if (!session) {
    const query = new URLSearchParams();

    for (const [name, value] of Object.entries(params)) {
      if (typeof value === "string") {
        query.set(name, value);
      }
    }

    redirect(
      `/login?next=${encodeURIComponent(`/oauth/authorize?${query.toString()}`)}`,
    );
  }

  if (await needsTwoFactorSetup(await getSettings(), session.user)) {
    redirect("/two-step-setup");
  }

  if (session.user.emailVerified !== true) {
    return (
      <Card title="Verify your email first">
        <p>Confirm your email address, then ask the app to start again.</p>
      </Card>
    );
  }

  const parsed = await parseAuthorizeRequest(read);

  if (!parsed.ok && parsed.kind === "fatal") {
    return (
      <Card title="This request cannot be used">
        <p>{parsed.message}</p>
        <p>Nothing was shared. You can close this page.</p>
      </Card>
    );
  }

  if (!parsed.ok) {
    redirect(
      buildRedirect(parsed.redirectUri, {
        error: parsed.error,
        error_description: parsed.description,
        state: parsed.state,
      }),
    );
  }

  const { request } = parsed;

  return (
    <OAuthConsent
      appName={request.client.name}
      email={session.user.email}
      ownerName={request.client.ownerName}
      params={{
        client_id: request.client.clientId,
        code_challenge: request.codeChallenge,
        code_challenge_method: "S256",
        redirect_uri: request.redirectUri,
        response_type: "code",
        scope: request.scope,
        state: request.state,
      }}
      returnsTo={new URL(request.redirectUri).host || request.redirectUri}
      scope={request.scope}
    />
  );
}

function Card({
  children,
  title,
}: Readonly<{ children: React.ReactNode; title: string }>) {
  return (
    <section className="panel w-full max-w-[460px] space-y-4 p-8 text-sm leading-6 text-(--secondary) sm:p-10">
      <h1 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
        {title}
      </h1>
      {children}
    </section>
  );
}
