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
import {
  ALTERNATIVE_POINTS,
  API_EXAMPLE,
  API_HIGHLIGHTS,
  BEFORE_YOU_SWITCH,
  FEATURES,
  SECURITY_FAQ,
  SECURITY_POINTS,
} from "@/lib/marketing-content";

export function AlternativePage() {
  return (
    <MarketingShell>
      <Hero
        eyebrow="DocuSign alternative"
        intro="GCM eSign is an e-signature service for teams that want to send, sign and keep documents with a clear record, and connect it to their own software."
        title="A DocuSign alternative you control."
      />
      <Section title="Why teams look at GCM eSign">
        <CardGrid items={ALTERNATIVE_POINTS} />
      </Section>
      <Section title="What you get">
        <CardGrid items={FEATURES} />
      </Section>
      <Section title="Before you switch">
        <ul className="list-disc space-y-2 pl-6 text-(--muted)">
          {BEFORE_YOU_SWITCH.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="mt-6">
          <Link className={ghostClass} href="/esign-api">
            See the API
          </Link>
        </p>
      </Section>
    </MarketingShell>
  );
}

export function ApiPage() {
  return (
    <MarketingShell>
      <Hero
        eyebrow="E-signature API"
        intro="Send documents for signature from your own software, follow their progress, and receive signed notifications when they change."
        title="An e-signature API that is easy to start with."
      />
      <Section title="What the API does">
        <CardGrid items={API_HIGHLIGHTS} />
      </Section>
      <Section title="A request">
        <pre className="panel overflow-x-auto p-5 text-sm">
          <code>{API_EXAMPLE}</code>
        </pre>
        <p className="mt-4 text-(--muted)">
          The interactive reference lives at /api/v1 once you have access.
        </p>
      </Section>
    </MarketingShell>
  );
}

export function SecurityPage() {
  return (
    <MarketingShell>
      <JsonLd data={faqJsonLd(SECURITY_FAQ)} />
      <Hero
        eyebrow="Security"
        intro="What GCM eSign does to keep documents and signing links private, and to leave a record of what happened."
        title="Security for electronic signatures."
      />
      <Section title="What protects your documents">
        <CardGrid items={SECURITY_POINTS} />
      </Section>
      <Section title="Questions">
        <FaqList items={SECURITY_FAQ} />
      </Section>
    </MarketingShell>
  );
}
