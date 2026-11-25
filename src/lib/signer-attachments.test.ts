import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fieldPlacementSchema,
  signingFieldSubmissionSchema,
} from "./schemas/field.ts";
import { describeSignerAttachments } from "./services/pdf-finalize.ts";
import {
  cleanSignerAttachmentFileName,
  detectSignerAttachmentType,
} from "./signer-attachments.ts";

// Signly: what a signer may attach, and how its name is kept.

test("the type of an attached file comes from its bytes", () => {
  const bytes = (...values: number[]) => new Uint8Array(values);

  assert.equal(
    detectSignerAttachmentType(new TextEncoder().encode("%PDF-1.7\n")),
    "application/pdf",
  );
  assert.equal(
    detectSignerAttachmentType(
      bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0),
    ),
    "image/png",
  );
  assert.equal(
    detectSignerAttachmentType(bytes(0xff, 0xd8, 0xff, 0xe0)),
    "image/jpeg",
  );
  assert.equal(
    detectSignerAttachmentType(new TextEncoder().encode("<svg></svg>")),
    null,
  );
  assert.equal(detectSignerAttachmentType(bytes()), null);
});

test("an attached file's name loses folders and control characters and keeps its real extension", () => {
  assert.equal(
    cleanSignerAttachmentFileName(
      "C:\\Users\\me\\passport.pdf",
      "application/pdf",
    ),
    "passport.pdf",
  );
  assert.equal(
    cleanSignerAttachmentFileName("../../etc/x\u0000.pdf", "application/pdf"),
    "x.pdf",
  );
  assert.equal(
    cleanSignerAttachmentFileName("scan.pdf", "image/png"),
    "scan.pdf.png",
  );
  assert.equal(
    cleanSignerAttachmentFileName("photo.JPEG", "image/jpeg"),
    "photo.JPEG",
  );
  assert.equal(
    cleanSignerAttachmentFileName("", "image/jpeg"),
    "attachment.jpg",
  );
  assert.equal(
    cleanSignerAttachmentFileName(null, "application/pdf"),
    "attachment.pdf",
  );
  assert.equal(
    cleanSignerAttachmentFileName(".pdf", "application/pdf"),
    "attachment.pdf",
  );

  const long = cleanSignerAttachmentFileName(
    `${"a".repeat(300)}.pdf`,
    "application/pdf",
  );

  assert.equal(long.length, 200);
  assert.ok(long.endsWith(".pdf"));
});

test("an attachment field can be optional, and is submitted by upload id", () => {
  const placed = fieldPlacementSchema.parse({
    height: 0.05,
    page: 1,
    required: false,
    signerId: "s1",
    type: "attachment",
    width: 0.2,
    x: 0.1,
    y: 0.1,
  });

  assert.equal(placed.required, false);
  assert.deepEqual(
    signingFieldSubmissionSchema.parse({
      fieldId: "f1",
      type: "attachment",
      uploadId: "u1",
    }),
    { fieldId: "f1", type: "attachment", uploadId: "u1" },
  );
  assert.equal(
    signingFieldSubmissionSchema.safeParse({
      fieldId: "f1",
      type: "attachment",
    }).success,
    false,
  );
});

test("the certificate lists attached files, without their names for other signers", () => {
  const signed = {
    actorType: "signer" as const,
    createdAt: 1,
    envelopeId: "e1",
    event: "signed" as const,
    id: "a1",
    metadata: {
      attachments: [
        {
          contentType: "application/pdf",
          fieldId: "f1",
          fileName: "passport.pdf",
          sha256: "b".repeat(64),
          sizeBytes: 2 * 1024 * 1024,
        },
        { fileName: 3 },
      ],
    },
  };

  assert.deepEqual(describeSignerAttachments(signed), [
    `Attached file: passport.pdf (2.0 MB, SHA-256 ${"b".repeat(64)})`,
  ]);
  assert.deepEqual(describeSignerAttachments(signed, true), [
    `Attached a file (2.0 MB, SHA-256 ${"b".repeat(64)})`,
  ]);
  assert.deepEqual(describeSignerAttachments(undefined), []);
});
