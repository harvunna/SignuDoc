import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { PDFDocument } from "pdf-lib";

import {
  MAX_DOCUMENTS_PER_ENVELOPE,
  MAX_UPLOAD_SIZE_BYTES,
} from "../types/domain.ts";
import { combinedFilename, combineSourcePdfs } from "./document-combine.ts";
import { DocumentImportError, importPdfDocument } from "./document-import.ts";

async function pdf(sizes: Array<[number, number]>): Promise<Uint8Array> {
  const document = await PDFDocument.create();

  for (const size of sizes) {
    document.addPage(size);
  }

  return document.save();
}

test("several PDFs are joined in order, and each one's pages are recorded", async () => {
  const first = await pdf([
    [612, 792],
    [612, 792],
  ]);
  const second = await pdf([[792, 612]]);
  const third = await pdf([
    [595, 842],
    [595, 842],
    [595, 842],
  ]);
  const combined = await combineSourcePdfs([
    { body: first, contentType: "application/pdf", filename: "Offer.pdf" },
    { body: second, filename: "Wide.pdf" },
    { body: third, filename: "A4 pack.pdf" },
  ]);

  assert.equal(combined.filename, "Offer + 2 more.pdf");
  assert.deepEqual(
    combined.documents.map((document) => [
      document.name,
      document.firstPage,
      document.pageCount,
    ]),
    [
      ["Offer.pdf", 1, 2],
      ["Wide.pdf", 3, 1],
      ["A4 pack.pdf", 4, 3],
    ],
  );
  assert.equal(
    combined.documents[1]!.sha256,
    createHash("sha256").update(second).digest("hex"),
  );

  // The joined file imports like any upload, page sizes kept.
  const imported = await importPdfDocument({
    body: combined.body,
    filename: combined.filename,
  });

  assert.equal(imported.pageCount, 6);
  assert.deepEqual(
    imported.pages.map((page) => [page.widthPt, page.heightPt]),
    [
      [612, 792],
      [612, 792],
      [792, 612],
      [595, 842],
      [595, 842],
      [595, 842],
    ],
  );
});

test("a bad file is named, and the limits apply to all of them together", async () => {
  const good = await pdf([[612, 792]]);

  await assert.rejects(
    combineSourcePdfs([
      { body: good, filename: "good.pdf" },
      { body: new TextEncoder().encode("not a pdf"), filename: "bad.pdf" },
    ]),
    (error: unknown) =>
      error instanceof DocumentImportError &&
      error.code === "invalid_type" &&
      error.message.startsWith("bad.pdf: "),
  );

  await assert.rejects(
    combineSourcePdfs(
      Array.from({ length: MAX_DOCUMENTS_PER_ENVELOPE + 1 }, (_, index) => ({
        body: good,
        filename: `${String(index)}.pdf`,
      })),
    ),
    (error: unknown) =>
      error instanceof DocumentImportError &&
      error.code === "too_many_documents",
  );

  const half = new Uint8Array(Math.floor(MAX_UPLOAD_SIZE_BYTES / 2) + 1);

  await assert.rejects(
    combineSourcePdfs([
      { body: half, filename: "one.pdf" },
      { body: half, filename: "two.pdf" },
    ]),
    (error: unknown) =>
      error instanceof DocumentImportError &&
      error.code === "too_large_together",
  );
});

test("the joined file's name keeps to 255 characters and ends in .pdf", () => {
  const name = combinedFilename([`${"x".repeat(300)}.pdf`, "b.pdf"]);

  assert.ok(name.length <= 255);
  assert.ok(name.endsWith(" + 1 more.pdf"));
  assert.equal(combinedFilename(["only.PDF"]), "only.pdf");
});
