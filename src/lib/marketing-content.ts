// Signly: the words on the public pages. Everything said here is something
// the product does today; do not add a claim the code cannot back up.

export const CONTACT_EMAIL = "contact@globalcomputingmachines.com";
export const REQUEST_ACCESS_HREF = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("GCM eSign access")}`;

export type Feature = { body: string; title: string };
export type Faq = { answer: string; question: string };

export const FEATURES: readonly Feature[] = [
  {
    title: "Several documents in one envelope",
    body: "Send up to 10 PDFs together. Signers see each document's name and can jump between them.",
  },
  {
    title: "Signing order that fits the deal",
    body: "One signer after another, or groups who sign at the same time. Reminders go out for anyone who is slow.",
  },
  {
    title: "Fields for real paperwork",
    body: "Signature, initials, date, text, checkbox and file attachment fields, each assigned to a signer.",
  },
  {
    title: "Sign in person",
    body: "Hand your device to someone in the room. The signature is recorded as signed in person, with who hosted it.",
  },
  {
    title: "Templates and bulk send",
    body: "Save a document once and send it to many people. Teams share templates and see each other's envelopes.",
  },
  {
    title: "A record you can show",
    body: "A certificate of completion lists who signed, when, and the SHA-256 fingerprint of every document.",
  },
  {
    title: "Reports and CSV export",
    body: "See what was sent, finished, waiting or declined in a period, who has been waiting longest, and download it as CSV.",
  },
  {
    title: "API and webhooks",
    body: "Create, send and track envelopes from your own software, and get signed notifications when something changes.",
  },
];

export const STEPS: readonly Feature[] = [
  {
    title: "Upload",
    body: "Add the PDF or PDFs you already have. Nothing to rebuild.",
  },
  {
    title: "Add signers and fields",
    body: "Say who signs and where. Set the order.",
  },
  {
    title: "Send",
    body: "Each signer gets a private link by email. They do not need an account.",
  },
  {
    title: "Download the signed copy",
    body: "Everyone gets the finished PDF and a certificate of completion.",
  },
];

export const HOME_FAQ: readonly Faq[] = [
  {
    question: "What is GCM eSign?",
    answer:
      "GCM eSign is e-signature software from Global Computing Machines. You upload a PDF, choose who signs and where, and send it. Signers sign from a link in their email, and everyone receives the signed PDF with a certificate of completion.",
  },
  {
    question: "Do signers need an account?",
    answer:
      "No. A signer opens the private link in their email and signs. Only the people who send documents sign in.",
  },
  {
    question: "Is an electronic signature legally valid?",
    answer:
      "In the United States, electronic signatures are generally recognised under the ESIGN Act and UETA, but some documents, such as wills and certain notices, cannot be signed electronically. GCM eSign shows which documents it is meant for, and asks senders to confirm before each send. This is not legal advice.",
  },
  {
    question: "Can I connect GCM eSign to my own software?",
    answer:
      "Yes. There is a REST API with API keys, signed webhooks for status changes, and embedded signing that shows the signing page inside your own app.",
  },
  {
    question: "How is access protected?",
    answer:
      "Accounts can require a two-step sign-in code. Every signing link is private and expires. Each action on an envelope is written to an audit trail.",
  },
  {
    question: "How do I get access?",
    answer: `Write to ${CONTACT_EMAIL} and we will set you up.`,
  },
];

export const ALTERNATIVE_POINTS: readonly Feature[] = [
  {
    title: "You control the account",
    body: "Your people, your teams, your templates and your reports sit together. Administrators decide who can send and who can see what.",
  },
  {
    title: "No per-signer accounts",
    body: "People who only need to sign never create an account or install anything.",
  },
  {
    title: "An API for your own software",
    body: "Send documents from your system and read the result back, with API keys that each person can make for themselves.",
  },
  {
    title: "A clear record",
    body: "Every envelope has an audit trail, and the certificate lists each document with its fingerprint.",
  },
];

export const BEFORE_YOU_SWITCH: readonly string[] = [
  "Check that the documents you send can be signed electronically where you work. Some kinds cannot.",
  "Check whether you need a signature type that is stricter than a standard electronic signature, such as a qualified signature under EU rules. GCM eSign collects standard electronic signatures.",
  "List the other systems that send or receive your documents, and check the API covers them.",
  "Send a few real documents first and ask signers how it felt.",
];

export const API_HIGHLIGHTS: readonly Feature[] = [
  {
    title: "One call to send",
    body: "Upload one or several PDFs, name the signers, place the fields and send, in a single request.",
  },
  {
    title: "API keys for everyone",
    body: "Anyone with an account can make their own keys. A key acts as the person who made it and can be read-only.",
  },
  {
    title: "Signed webhooks",
    body: "Deliveries follow the Standard Webhooks format, so you can check each one really came from us.",
  },
  {
    title: "Embedded signing",
    body: "Show the signing page inside your own app instead of sending an email.",
  },
  {
    title: "Safe to retry",
    body: "Send an Idempotency-Key and a repeated request will not create a second envelope.",
  },
  {
    title: "A reference you can try",
    body: "The API reference is an interactive page. Paste a key and try each call.",
  },
];

export const API_EXAMPLE = `curl https://esign.globalcomputingmachines.com/api/v1/envelopes \\
  -H "Authorization: Bearer sdk_…" \\
  -H "Idempotency-Key: order-1042" \\
  -F file=@agreement.pdf \\
  -F 'data={
    "title": "Service agreement",
    "signers": [
      { "ref": "client", "name": "Casey Client", "email": "casey@example.com" }
    ],
    "fields": [
      { "signer": "client", "type": "signature", "page": 1,
        "x": 0.1, "y": 0.8, "width": 0.3, "height": 0.05 }
    ],
    "send": { "expiresInDays": 14, "permittedUseConfirmed": true }
  }'`;

export const SECURITY_POINTS: readonly Feature[] = [
  {
    title: "Two-step sign-in",
    body: "People who send documents can be required to enter a code from an authenticator app after their password.",
  },
  {
    title: "Private, expiring signing links",
    body: "Each signer gets their own link. It cannot be guessed and stops working at the deadline the sender sets.",
  },
  {
    title: "An audit trail",
    body: "Views, signatures, declines, changes and downloads are recorded with the time they happened.",
  },
  {
    title: "Sealed, verifiable PDFs",
    body: "The finished PDF is sealed so changes after signing can be detected, and anyone can check a file on the verify page.",
  },
  {
    title: "Roles and teams",
    body: "Administrators decide who can send, who sees which team's envelopes, and who can make API keys.",
  },
  {
    title: "Limits you can see",
    body: "The site states which documents it is meant for, and asks senders to confirm before each send.",
  },
];

export const SECURITY_FAQ: readonly Faq[] = [
  {
    question: "Who can see my documents?",
    answer:
      "The sender, the signers of that envelope, anyone the sender copies on it, and teammates or administrators your organization has given access to. Downloads by teammates and administrators are logged.",
  },
  {
    question: "Can I tell if a signed PDF was changed?",
    answer:
      "Yes. The signed PDF is sealed, and the verify page checks a file against the record.",
  },
  {
    question: "Does GCM eSign give legal advice?",
    answer:
      "No. It collects electronic signatures. Whether a particular document can be signed electronically, and what a signature is worth, depends on the document and where you are. Ask a lawyer if you are unsure.",
  },
];
