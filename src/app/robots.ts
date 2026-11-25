import type { MetadataRoute } from "next";

import {
  PRIVATE_PATHS,
  isPublicSite,
  publicSiteOrigin,
} from "@/lib/public-site";

// Signly: customer sites are kept out of search engines; the public site
// is open except for the app's own pages.
export default function robots(): MetadataRoute.Robots {
  if (!isPublicSite()) {
    return { rules: { disallow: "/", userAgent: "*" } };
  }

  const origin = publicSiteOrigin();

  return {
    rules: { allow: "/", disallow: [...PRIVATE_PATHS], userAgent: "*" },
    ...(origin ? { host: origin, sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
