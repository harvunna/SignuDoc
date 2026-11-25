import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeDocumentPage,
  describePageRange,
  documentsToStore,
  findDocumentForPage,
  listEnvelopeDocuments,
  parseStoredDocuments,
  toDocumentViews,
} from "./envelope-documents.ts";

const HASH = "c".repeat(64);
const two = [
  { firstPage: 1, name: "a.pdf", pageCount: 2, sha256: HASH, sizeBytes: 10 },
  { firstPage: 3, name: "b.pdf", pageCount: 3, sha256: HASH, sizeBytes: 20 },
];

test("a stored list is used only when it covers every page in order", () => {
  assert.deepEqual(parseStoredDocuments(two, 5), two);
  assert.equal(parseStoredDocuments(two, 6), null);
  assert.equal(parseStoredDocuments([two[1], two[0]], 5), null);
  assert.equal(parseStoredDocuments([two[0]], 2), null);
  assert.equal(parseStoredDocuments({ not: "a list" }, 5), null);
  assert.equal(parseStoredDocuments(null, 5), null);
});

test("an envelope without a list is one document named by its file", () => {
  const documents = listEnvelopeDocuments({
    documents: null,
    pageCount: 4,
    sourcePdfFilename: "contract.pdf",
    sourcePdfHash: HASH,
    sourcePdfSizeBytes: 99,
  });

  assert.deepEqual(documents, [
    {
      firstPage: 1,
      name: "contract.pdf",
      pageCount: 4,
      sha256: HASH,
      sizeBytes: 99,
    },
  ]);
  assert.equal(documentsToStore(documents), null);
  assert.deepEqual(documentsToStore(two), two);
});

test("pages are named by their document", () => {
  const views = toDocumentViews(two);

  assert.equal(findDocumentForPage(views, 3)?.name, "b.pdf");
  assert.equal(findDocumentForPage(views, 6), undefined);
  assert.equal(describeDocumentPage(views, 4), "b.pdf, page 2 of 3");
  assert.equal(describeDocumentPage(views.slice(0, 1), 1), null);
  assert.equal(describePageRange(two[1]!), "pages 3-5");
  assert.equal(describePageRange({ firstPage: 2, pageCount: 1 }), "page 2");
  assert.deepEqual(
    views.map((view) => [view.index, view.lastPage]),
    [
      [1, 2],
      [2, 5],
    ],
  );
});
