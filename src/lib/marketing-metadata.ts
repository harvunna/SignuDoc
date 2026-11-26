import type { Metadata } from "next";

import { isPublicSite, publicSiteOrigin } from "./public-site.ts";

type PageMetadataInput = {
  description: string;
  path: string;
  title: string;
};

// GCM eSign: the same title, description, address and share card for every
// public page. Off the public site, a page asks search engines to skip it.
export function buildPageMetadata({
  description,
  path,
  title,
}: PageMetadataInput): Metadata {
  const origin = publicSiteOrigin();

  return {
    alternates: { canonical: path },
    description,
    ...(origin ? { metadataBase: new URL(origin) } : {}),
    openGraph: {
      description,
      siteName: "GCM eSign",
      title,
      type: "website",
      url: path,
    },
    robots: isPublicSite() ? { follow: true, index: true } : { index: false },
    title: { absolute: title },
    twitter: { card: "summary", description, title },
  };
}
