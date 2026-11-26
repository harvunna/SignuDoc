// GCM eSign: the public marketing site, only on the install that turns it on.
//
// Customer sites should not show up in search engines, and a sign-in page
// has nothing for a search engine to read. The one site that sells the
// product (GCM's own) sets GCMESIGN_PUBLIC_SITE=true: it gets a home page,
// a few pages for the searches people make, a sitemap and a robots file.
// Everywhere else the robots file tells search engines to stay away.

import { readSiteEnv, resolveAppUrl, type EnvSource } from "./utils/env.ts";

export function isPublicSite(env: EnvSource = process.env): boolean {
  const value = readSiteEnv(env, "PUBLIC_SITE")?.toLowerCase();

  return value === "1" || value === "true";
}

/** "https://esign.example.com" from APP_URL, or undefined when not set. */
export function publicSiteOrigin(
  env: EnvSource = process.env,
): string | undefined {
  try {
    const appUrl = resolveAppUrl(env);

    return appUrl ? new URL(appUrl).origin : undefined;
  } catch {
    return undefined;
  }
}

export type PublicPage = {
  changeFrequency: "daily" | "weekly" | "monthly" | "yearly";
  path: string;
  priority: number;
};

export const PUBLIC_PAGES: readonly PublicPage[] = [
  { changeFrequency: "weekly", path: "/", priority: 1 },
  { changeFrequency: "monthly", path: "/docusign-alternative", priority: 0.8 },
  { changeFrequency: "monthly", path: "/esign-api", priority: 0.8 },
  { changeFrequency: "monthly", path: "/security", priority: 0.7 },
];

/** Pages that belong to signed-in people or to one signer: never indexed. */
export const PRIVATE_PATHS: readonly string[] = [
  "/api/",
  "/dashboard",
  "/embed/",
  "/envelopes",
  "/login",
  "/reports",
  "/settings",
  "/setup",
  "/sign/",
  "/signup",
  "/templates",
  "/two-step-setup",
  "/verify",
];
