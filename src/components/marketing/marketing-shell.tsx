import Link from "next/link";
import type { ReactNode } from "react";

import { REQUEST_ACCESS_HREF } from "@/lib/marketing-content";

const NAV = [
  { href: "/docusign-alternative", label: "DocuSign alternative" },
  { href: "/esign-api", label: "E-signature API" },
  { href: "/security", label: "Security" },
];

export const ctaClass =
  "inline-flex h-11 items-center justify-center rounded-full bg-(--accent) px-6 text-sm font-bold text-white transition hover:bg-(--accent-hover)";
export const ghostClass =
  "inline-flex h-11 items-center justify-center rounded-full border border-(--border) px-6 text-sm font-bold text-(--fg) transition hover:bg-(--secondary)";

// GCM eSign: the frame around every public page: a header, the page, a footer.
export function MarketingShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-(--bg) text-(--fg)">
      <header className="border-b border-(--border)">
        <div className="page-width flex flex-wrap items-center justify-between gap-4 py-4">
          <Link className="text-lg font-extrabold tracking-[-0.02em]" href="/">
            GCM eSign
          </Link>
          <nav
            aria-label="Main"
            className="flex flex-wrap items-center gap-5 text-sm font-semibold"
          >
            {NAV.map((item) => (
              <Link
                className="hover:text-(--accent)"
                href={item.href}
                key={item.href}
              >
                {item.label}
              </Link>
            ))}
            <Link className="hover:text-(--accent)" href="/login">
              Sign in
            </Link>
            <a className={ctaClass} href={REQUEST_ACCESS_HREF}>
              Request access
            </a>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-(--border) py-8 text-sm text-(--muted)">
        <div className="page-width flex flex-wrap justify-between gap-4">
          <p>
            © {new Date().getFullYear()} Global Computing Machines. GCM eSign
            collects electronic signatures. It does not give legal advice.
          </p>
          <nav aria-label="Footer" className="flex flex-wrap gap-4">
            <Link href="/electronic-signatures">What it is for</Link>
            <Link href="/security">Security</Link>
            <Link href="/verify">Verify a document</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

export function JsonLd({ data }: { data: object }) {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
      type="application/ld+json"
    />
  );
}

export function Section({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="page-width py-12">
      <h2 className="mb-6 text-2xl font-extrabold tracking-[-0.02em]">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function CardGrid({
  items,
}: {
  items: readonly { body: string; title: string }[];
}) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {items.map((item) => (
        <li className="panel p-5" key={item.title}>
          <h3 className="font-bold">{item.title}</h3>
          <p className="mt-2 text-sm text-(--muted)">{item.body}</p>
        </li>
      ))}
    </ul>
  );
}

export function FaqList({
  items,
}: {
  items: readonly { answer: string; question: string }[];
}) {
  return (
    <dl className="space-y-5">
      {items.map((item) => (
        <div key={item.question}>
          <dt className="font-bold">{item.question}</dt>
          <dd className="mt-1 text-(--muted)">{item.answer}</dd>
        </div>
      ))}
    </dl>
  );
}

export function faqJsonLd(
  items: readonly { answer: string; question: string }[],
) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      acceptedAnswer: { "@type": "Answer", text: item.answer },
      name: item.question,
    })),
  };
}

export function Hero({
  children,
  eyebrow,
  intro,
  title,
}: {
  children?: ReactNode;
  eyebrow: string;
  intro: string;
  title: string;
}) {
  return (
    <section className="page-width py-16">
      <p className="text-sm font-bold uppercase tracking-wide text-(--accent)">
        {eyebrow}
      </p>
      <h1 className="mt-3 max-w-3xl text-4xl font-extrabold tracking-[-0.03em] sm:text-5xl">
        {title}
      </h1>
      <p className="mt-5 max-w-2xl text-lg text-(--muted)">{intro}</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <a className={ctaClass} href={REQUEST_ACCESS_HREF}>
          Request access
        </a>
        {children}
      </div>
    </section>
  );
}
