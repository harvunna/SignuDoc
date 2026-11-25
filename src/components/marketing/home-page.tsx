import Link from "next/link";

import {
  CardGrid,
  faqJsonLd,
  FaqList,
  ghostClass,
  Hero,
  JsonLd,
  MarketingShell,
  Section,
} from "@/components/marketing/marketing-shell";
import { FEATURES, HOME_FAQ, STEPS } from "@/lib/marketing-content";
import { publicSiteOrigin } from "@/lib/public-site";

export function HomePage() {
  const origin = publicSiteOrigin();

  return (
    <MarketingShell>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Organization",
              name: "Global Computing Machines",
              url: "https://www.globalcomputingmachines.com",
            },
            {
              "@type": "SoftwareApplication",
              applicationCategory: "BusinessApplication",
              description:
                "E-signature software: send documents for electronic signature, track them, and keep a record of who signed.",
              name: "GCM eSign",
              operatingSystem: "Web",
              ...(origin ? { url: origin } : {}),
            },
          ],
        }}
      />
      <JsonLd data={faqJsonLd(HOME_FAQ)} />
      <Hero
        eyebrow="eSign software"
        intro="Upload a PDF, say who signs and where, and send it. Signers sign from a link in their email, with no account. Everyone gets the signed PDF and a certificate of completion."
        title="eSign documents, simply and with a record."
      >
        <Link className={ghostClass} href="/docusign-alternative">
          A DocuSign alternative
        </Link>
      </Hero>
      <Section title="How it works">
        <CardGrid items={STEPS} />
      </Section>
      <Section title="What you can do">
        <CardGrid items={FEATURES} />
      </Section>
      <Section title="Questions">
        <FaqList items={HOME_FAQ} />
      </Section>
    </MarketingShell>
  );
}
