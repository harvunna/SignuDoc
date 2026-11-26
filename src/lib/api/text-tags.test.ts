import assert from "node:assert/strict";
import test from "node:test";

import { PDFDocument, StandardFonts } from "pdf-lib";

import { placeFieldsByText } from "./text-placement.ts";
import {
  anchorPattern,
  findMatches,
  parseTag,
  placeBeside,
  scanPdf,
  TAG_PATTERN,
  type TextRun,
} from "./text-tags.ts";

function run(str: string, x: number, y: number, extra: Partial<TextRun> = {}) {
  return {
    advance: str.length * 6,
    dirX: 1,
    dirY: 0,
    hasEOL: false,
    height: 10,
    str,
    x,
    y,
    ...extra,
  } satisfies TextRun;
}

async function samplePdf(lines: Array<{ text: string; x: number; y: number }>) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([600, 800]);

  for (const line of lines) {
    page.drawText(line.text, { font, size: 12, x: line.x, y: line.y });
  }

  return pdf.save();
}

test("parseTag reads type, signer and options", () => {
  assert.deepEqual(parseTag("signature:client"), {
    required: true,
    signer: "client",
    type: "signature",
  });
  assert.deepEqual(parseTag("text:client:optional:label=Company name"), {
    label: "Company name",
    required: false,
    signer: "client",
    type: "text",
  });
  assert.deepEqual(parseTag("dropdown:client:options=A|B|C")?.options, [
    "A",
    "B",
    "C",
  ]);
  assert.equal(parseTag("1"), null);
  assert.throws(() => parseTag("signatur:client"), /not a field type/);
});

test("parseTag refuses what it cannot place", () => {
  assert.equal(parseTag("signature"), null);
  assert.throws(() => parseTag("signature:"), /signer's ref/);
  assert.throws(() => parseTag("radio:client"), /group/);
  assert.throws(() => parseTag("dropdown:client:options=A"), /two or more/);
  assert.throws(() => parseTag("text:client:color=red"), /not a tag option/);
});

test("findMatches finds a tag split across runs", () => {
  const runs = [
    run("Sign: [[signa", 10, 700),
    run("ture:client]] here", 82, 700),
  ];
  const matches = findMatches(runs, TAG_PATTERN);

  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.text, "[[signature:client]]");
  assert.equal(matches[0]!.pieces.length, 2);
});

test("findMatches boxes only the matched part of a run", () => {
  const [match] = findMatches([run("ab [[date:c]] cd", 0, 0)], TAG_PATTERN);
  const left = Math.min(...match!.quad.map((point) => point.x));
  const right = Math.max(...match!.quad.map((point) => point.x));

  assert.equal(left, 18);
  assert.equal(right, 18 + 10 * 6);
});

test("anchorPattern ignores case and spacing", () => {
  const runs = [run("SIGNATURE  of Client", 0, 0)];

  assert.equal(
    findMatches(runs, anchorPattern("signature of client")).length,
    1,
  );
  assert.equal(findMatches(runs, anchorPattern("a.b")).length, 0);
});

test("placeBeside keeps the field on the page", () => {
  const box = { bottom: 0.52, left: 0.1, right: 0.2, top: 0.5 };
  const size = { height: 0.05, width: 0.25 };

  const beside = placeBeside(box, size);

  assert.ok(Math.abs(beside.x - 0.21) < 1e-9);
  assert.ok(Math.abs(beside.y - 0.485) < 1e-9);
  assert.equal(placeBeside(box, size, { position: "below" }).y, 0.525);
  assert.equal(
    placeBeside({ ...box, right: 0.95 }, size).x,
    0.75,
    "pulled back inside the page",
  );
});

test("scanPdf and placeFieldsByText turn a tag into a field and cover it", async () => {
  const body = await samplePdf([
    { text: "Agreement", x: 50, y: 700 },
    { text: "[[signature:client]]", x: 300, y: 400 },
    { text: "[[date:client:optional]]", x: 300, y: 300 },
  ]);
  const placed = await placeFieldsByText(
    { fields: [], signers: [{ ref: "client" }], textTags: true },
    [{ body, filename: "a.pdf" }],
    500,
  );

  assert.equal(placed.fields.length, 2);

  const [signature, date] = placed.fields;

  assert.equal(signature!.type, "signature");
  assert.equal(signature!.page, 1);
  assert.equal(signature!.document, 1);
  assert.ok(Math.abs(signature!.x - 300 / 600) < 0.01);
  // 400 points up from the bottom of an 800 point page is the middle.
  assert.ok(Math.abs(signature!.y + signature!.height / 2 - 0.5) < 0.03);
  assert.equal(date!.required, false);

  // The PDF was changed (white boxes over the tags) and kept its text.
  assert.notDeepEqual(placed.pdfs[0]!.body, body);

  const pages = await scanPdf(placed.pdfs[0]!.body);

  assert.ok(pages[0]!.runs.some((item) => item.str.includes("Agreement")));
});

test("an anchor places a field beside the words, and says when it cannot", async () => {
  const body = await samplePdf([
    { text: "Signature of Client", x: 50, y: 400 },
  ]);
  const input = {
    fields: [
      {
        anchor: { text: "signature of client" },
        signer: "client",
        type: "signature" as const,
      },
    ],
    signers: [{ ref: "client" }],
  };
  const placed = await placeFieldsByText(
    input,
    [{ body, filename: "a.pdf" }],
    500,
  );

  assert.equal(placed.fields[0]!.page, 1);
  assert.ok(placed.fields[0]!.x > 50 / 600);

  await assert.rejects(
    placeFieldsByText(
      {
        ...input,
        fields: [{ ...input.fields[0]!, anchor: { text: "Nowhere" } }],
      },
      [{ body, filename: "a.pdf" }],
      500,
    ),
    /fields.0.anchor: the text "Nowhere" was not found/,
  );
  await assert.rejects(
    placeFieldsByText(
      {
        ...input,
        fields: [
          { ...input.fields[0]!, anchor: { occurrence: 2, text: "Signature" } },
        ],
      },
      [{ body, filename: "a.pdf" }],
      500,
    ),
    /fewer than occurrence 2/,
  );
});

test("a tag for an unknown signer or a document with no tags is refused", async () => {
  const withTag = await samplePdf([
    { text: "[[signature:bob]]", x: 50, y: 400 },
  ]);
  const plain = await samplePdf([{ text: "Nothing here", x: 50, y: 400 }]);
  const input = { fields: [], signers: [{ ref: "client" }], textTags: true };

  await assert.rejects(
    placeFieldsByText(input, [{ body: withTag, filename: "a.pdf" }], 500),
    /no signer has the ref "bob"/,
  );
  await assert.rejects(
    placeFieldsByText(input, [{ body: plain, filename: "a.pdf" }], 500),
    /no \[\[type:signer\]\] tags were found/,
  );
});
