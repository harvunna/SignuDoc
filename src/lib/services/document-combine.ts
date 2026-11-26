import { createHash } from "node:crypto";

import { PDFDocument } from "pdf-lib";

import type { EnvelopeDocument } from "../schemas/envelope.ts";
import {
  MAX_DOCUMENTS_PER_ENVELOPE,
  MAX_PDF_PAGES,
  MAX_UPLOAD_SIZE_BYTES,
} from "../types/domain.ts";
import { DocumentImportError, importPdfDocument } from "./document-import.ts";

// GCM eSign: joining several uploaded PDFs into the one source PDF of an
// envelope.
//
// Each file is checked on its own first, exactly as a single upload is
// (type, size, encryption, XFA, pages), so a bad file is named in the
// message. The pages are then copied, in the sender's order, into a new PDF,
// and the list of what went where is returned to be kept with the envelope.
//
// Joining is done once, when the draft is made. From then on the envelope
// has one source PDF like any other, which is why fields, signing, sealing,
// the certificate, verification and downloads need no change.
//
// What does not survive joining: interactive form fields, bookmarks and
// document-level scripts of the uploaded files. None of these is used by
// signing (fields are placed by the sender, and the signed PDF is flattened
// into stamped pages), so nothing a signer sees is lost.

export type SourcePdfInput = {
  body: Uint8Array;
  contentType?: string | null;
  filename: string;
};

export type CombinedSourcePdf = {
  body: Uint8Array;
  contentType: "application/pdf";
  /** One entry per file, in order. */
  documents: EnvelopeDocument[];
  filename: string;
};

function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

/** "Offer letter.pdf" and two more become "Offer letter + 2 more.pdf". */
export function combinedFilename(names: readonly string[]): string {
  const first = (names[0] ?? "document.pdf").replace(/\.pdf$/i, "");
  const suffix =
    names.length > 1 ? ` + ${String(names.length - 1)} more.pdf` : ".pdf";

  return `${first.slice(0, 255 - suffix.length)}${suffix}`;
}

/**
 * Joins the files into one PDF. Throws DocumentImportError, with the file
 * named, when any one of them would be refused as a single upload, and when
 * together they pass the size, page or document limits.
 */
export async function combineSourcePdfs(
  inputs: readonly SourcePdfInput[],
): Promise<CombinedSourcePdf> {
  if (inputs.length === 0) {
    throw new DocumentImportError("invalid_type", "A PDF file is required.");
  }

  if (inputs.length > MAX_DOCUMENTS_PER_ENVELOPE) {
    throw new DocumentImportError("too_many_documents");
  }

  const totalBytes = inputs.reduce((sum, input) => sum + input.body.length, 0);

  // Checked before anything is parsed: the joined file has to fit the same
  // limit as one upload, because it is stored, stamped and sealed as one.
  if (totalBytes > MAX_UPLOAD_SIZE_BYTES) {
    throw new DocumentImportError("too_large_together");
  }

  const combined = await PDFDocument.create();
  const documents: EnvelopeDocument[] = [];
  let nextPage = 1;

  for (const input of inputs) {
    let imported;

    try {
      imported = await importPdfDocument({
        body: input.body,
        contentType: input.contentType,
        filename: input.filename,
      });
    } catch (error) {
      if (error instanceof DocumentImportError) {
        throw new DocumentImportError(
          error.code,
          `${input.filename.trim() || "document.pdf"}: ${error.message}`,
        );
      }

      throw error;
    }

    if (nextPage - 1 + imported.pageCount > MAX_PDF_PAGES) {
      throw new DocumentImportError(
        "too_many_pages",
        `Together these files have more than ${String(MAX_PDF_PAGES)} pages. Send them in separate envelopes.`,
      );
    }

    const source = await PDFDocument.load(input.body);
    const pages = await combined.copyPages(source, source.getPageIndices());

    for (const page of pages) {
      combined.addPage(page);
    }

    documents.push({
      firstPage: nextPage,
      name: imported.filename,
      pageCount: imported.pageCount,
      sha256: sha256Hex(input.body),
      sizeBytes: imported.sizeBytes,
    });
    nextPage += imported.pageCount;
  }

  const body = await combined.save();

  // Joining can add a little (a shared page tree, new cross-references).
  if (body.length > MAX_UPLOAD_SIZE_BYTES) {
    throw new DocumentImportError("too_large_together");
  }

  return {
    body,
    contentType: "application/pdf",
    documents,
    filename: combinedFilename(documents.map((document) => document.name)),
  };
}
