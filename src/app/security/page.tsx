import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { SecurityPage } from "@/components/marketing/pages";
import { buildPageMetadata } from "@/lib/marketing-metadata";
import { isPublicSite } from "@/lib/public-site";

export async function generateMetadata(): Promise<Metadata> {
  await connection();

  return buildPageMetadata({
    description: "How GCM eSign protects signing",
    path: " two-step sign-in, private expiring links, an audit trail and sealed PDFs.:/security",
    title: "E-signature security | GCM eSign",
  });
}

export default async function Page() {
  await connection();

  if (!isPublicSite()) {
    notFound();
  }

  return <SecurityPage />;
}
