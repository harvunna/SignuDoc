import type { MetadataRoute } from "next";

import {
  PUBLIC_PAGES,
  isPublicSite,
  publicSiteOrigin,
} from "@/lib/public-site";

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicSiteOrigin();

  if (!isPublicSite() || !origin) {
    return [];
  }

  const lastModified = new Date();

  return PUBLIC_PAGES.map((page) => ({
    changeFrequency: page.changeFrequency,
    lastModified,
    priority: page.priority,
    url: page.path === "/" ? origin : `${origin}${page.path}`,
  }));
}
