// Signly: the documents an envelope is made of.
//
// An envelope has one source PDF. When the sender uploads several files
// they are joined into it (services/document-combine.ts), and the envelope
// keeps a list of what went in: each file's name and which pages of the
// joined PDF it became. Everything that works on the PDF (fields, signing,
// stamping, sealing, verifying, downloads) keeps working on one document;
// this list is only for showing people where one document ends and the next
// begins.
//
// Nothing here touches the server, so the builder and the signing page use
// it too.

import {
  envelopeDocumentListSchema,
  type EnvelopeDocument,
} from "./schemas/envelope.ts";

export type { EnvelopeDocument };

/** What the builder and the signing page need to know of each document. */
export type EnvelopeDocumentView = {
  firstPage: number;
  /** 1-based place in the envelope. */
  index: number;
  lastPage: number;
  name: string;
  pageCount: number;
};

type EnvelopeDocumentSource = {
  /** As stored: checked before use. */
  documents?: unknown;
  pageCount: number;
  sourcePdfFilename: string;
  sourcePdfHash: string;
  sourcePdfSizeBytes: number;
};

/**
 * Checks a stored list against the PDF it describes: the documents must
 * cover every page, in order, with no gap and no overlap. Returns null for
 * anything else, so a damaged list is shown as one document rather than
 * pointing at pages that are not there.
 */
export function parseStoredDocuments(
  value: unknown,
  pageCount: number,
): EnvelopeDocument[] | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = envelopeDocumentListSchema.safeParse(value);

  if (!parsed.success || parsed.data.length < 2) {
    return null;
  }

  let nextPage = 1;

  for (const document of parsed.data) {
    if (document.firstPage !== nextPage) {
      return null;
    }

    nextPage += document.pageCount;
  }

  return nextPage - 1 === pageCount ? parsed.data : null;
}

/**
 * The envelope's documents, always at least one: an envelope of one file
 * (or one from before Signly kept a list) is one document named by its
 * source file.
 */
export function listEnvelopeDocuments(
  envelope: EnvelopeDocumentSource,
): EnvelopeDocument[] {
  return (
    parseStoredDocuments(envelope.documents, envelope.pageCount) ?? [
      {
        firstPage: 1,
        name: envelope.sourcePdfFilename,
        pageCount: envelope.pageCount,
        sha256: envelope.sourcePdfHash,
        sizeBytes: envelope.sourcePdfSizeBytes,
      },
    ]
  );
}

/** The list as the builder and the signing page show it. */
export function toDocumentViews(
  documents: readonly EnvelopeDocument[],
): EnvelopeDocumentView[] {
  return documents.map((document, position) => ({
    firstPage: document.firstPage,
    index: position + 1,
    lastPage: document.firstPage + document.pageCount - 1,
    name: document.name,
    pageCount: document.pageCount,
  }));
}

/** The document a page of the joined PDF belongs to. */
export function findDocumentForPage<
  T extends { firstPage: number; pageCount: number },
>(documents: readonly T[], page: number): T | undefined {
  return documents.find(
    (document) =>
      page >= document.firstPage &&
      page < document.firstPage + document.pageCount,
  );
}

/**
 * "Offer letter.pdf, page 2 of 3" for a page of an envelope of several
 * documents, or null when there is only one (the page number says it all).
 */
export function describeDocumentPage(
  documents: readonly EnvelopeDocumentView[],
  page: number,
): string | null {
  if (documents.length < 2) {
    return null;
  }

  const document = findDocumentForPage(documents, page);

  return document
    ? `${document.name}, page ${String(page - document.firstPage + 1)} of ${String(document.pageCount)}`
    : null;
}

/** "pages 4-6", or "page 4" for a document of one page. */
export function describePageRange(document: {
  firstPage: number;
  pageCount: number;
}): string {
  const lastPage = document.firstPage + document.pageCount - 1;

  return document.pageCount === 1
    ? `page ${String(document.firstPage)}`
    : `pages ${String(document.firstPage)}-${String(lastPage)}`;
}

/**
 * The list to store for an envelope: null for one document, so a single
 * file is stored exactly as before.
 */
export function documentsToStore(
  documents: readonly EnvelopeDocument[] | null | undefined,
): EnvelopeDocument[] | null {
  return documents && documents.length > 1 ? [...documents] : null;
}
