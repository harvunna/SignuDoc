import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { ApiPage } from "@/components/marketing/pages";
import { buildPageMetadata } from "@/lib/marketing-metadata";
import { isPublicSite } from "@/lib/public-site";

export async function generateMetadata(): Promise<Metadata> {
  await connection();

  return buildPageMetadata({
    description:
      "Send documents for signature from your software with the GCM eSign REST API, API keys, signed webhooks and embedded signing.",
    path: "/esign-api",
    title: "E-signature API | GCM eSign",
  });
}

export default async function Page() {
  await connection();

  if (!isPublicSite()) {
    notFound();
  }

  return <ApiPage />;
}
