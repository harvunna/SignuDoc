import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { HomePage } from "@/components/marketing/home-page";
import { LandingShell } from "@/components/landing/landing-shell";
import { getAuthSession } from "@/lib/auth/server";
import { redirectToSetupIfNeeded } from "@/lib/install";
import { buildPageMetadata } from "@/lib/marketing-metadata";
import { isPublicSite } from "@/lib/public-site";
import { isHostedMode } from "@/lib/utils/env";

export async function generateMetadata(): Promise<Metadata | undefined> {
  await connection();

  if (!isPublicSite()) {
    return undefined;
  }

  return buildPageMetadata({
    description:
      "GCM eSign is e-signature software. Upload a PDF, add signers and fields, and send it. Signers sign from an email link, and everyone gets the signed PDF with a certificate of completion.",
    path: "/",
    title: "eSign software for sending and signing documents | GCM eSign",
  });
}

// The front door. A new install sends its first visitor to setup. After
// that, the hosted service shows its landing page, and every other install
// goes straight to the app: the documents for someone who is signed in, the
// sign-in page for everyone else.
export default async function Home() {
  // Decided per request, not when the app was built.
  await connection();
  await redirectToSetupIfNeeded();

  if (isHostedMode()) {
    return <LandingShell />;
  }

  const session = await getAuthSession();

  if (!session && isPublicSite()) {
    return <HomePage />;
  }

  redirect(session ? "/dashboard" : "/login");
}
