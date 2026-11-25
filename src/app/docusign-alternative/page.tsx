import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { AlternativePage } from "@/components/marketing/pages";
import { buildPageMetadata } from "@/lib/marketing-metadata";
import { isPublicSite } from "@/lib/public-site";

export async function generateMetadata(): Promise<Metadata> {
  await connection();

  return buildPageMetadata({
    description:
      "GCM eSign is a DocuSign alternative for sending, signing and keeping documents, with an API, teams, templates and an audit trail.",
    path: "/docusign-alternative",
    title: "DocuSign alternative | GCM eSign",
  });
}

export default async function Page() {
  await connection();

  if (!isPublicSite()) {
    notFound();
  }

  return <AlternativePage />;
}
