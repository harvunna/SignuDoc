import {
  anchorPattern,
  coverBoxes,
  DEFAULT_SIZES,
  findMatches,
  parseTag,
  placeBeside,
  scanPdf,
  TAG_PATTERN,
  TextTagError,
  toPageBox,
  type AnchorOptions,
  type FieldTypeName,
  type Quad,
  type ScannedPage,
} from "./text-tags.ts";

// GCM eSign: turns text tags and anchors into ordinary fields before the
// envelope is made, so nothing after this knows they existed.

export type RequestedField = {
  anchor?: AnchorOptions & { occurrence?: number; text: string };
  document?: number;
  groupId?: string;
  height?: number;
  label?: string;
  options?: string[];
  page?: number;
  required?: boolean;
  signer: string;
  type: FieldTypeName;
  width?: number;
  x?: number;
  y?: number;
};

export type PlacedField = {
  document?: number;
  groupId?: string;
  height: number;
  label?: string;
  options?: string[];
  page: number;
  required?: boolean;
  signer: string;
  type: FieldTypeName;
  width: number;
  x: number;
  y: number;
};

export type PlacementInput = {
  fields: readonly RequestedField[];
  signers: ReadonlyArray<{ ref: string }>;
  textTags?: boolean;
};

export type PlacementPdf = { body: Uint8Array; filename: string };

export class TextPlacementError extends Error {}

export function usesTextPlacement(input: PlacementInput): boolean {
  return input.textTags === true || input.fields.some((field) => field.anchor);
}

/**
 * Finds the fields that tags and anchors stand for. Returns them with the
 * PDFs, those with tags covered up. Throws TextPlacementError (a 400) with
 * what is wrong and where.
 */
export async function placeFieldsByText(
  input: PlacementInput,
  pdfs: readonly PlacementPdf[],
  maxFields: number,
): Promise<{ fields: PlacedField[]; pdfs: PlacementPdf[] }> {
  const scans: ScannedPage[][] = [];

  for (const pdf of pdfs) {
    scans.push(await scanPdf(pdf.body));
  }

  const knownSigners = new Set(input.signers.map((signer) => signer.ref));
  const fields: PlacedField[] = [];

  // Fields given in the request, in order. Those with an anchor are found.
  for (const [index, requested] of input.fields.entries()) {
    const where = `fields.${String(index)}`;
    const { anchor } = requested;

    if (!anchor) {
      fields.push({
        document: requested.document,
        groupId: requested.groupId,
        height: requested.height!,
        label: requested.label,
        options: requested.options,
        page: requested.page!,
        required: requested.required,
        signer: requested.signer,
        type: requested.type,
        width: requested.width!,
        x: requested.x!,
        y: requested.y!,
      });
      continue;
    }

    const documentNumber = requested.document ?? 1;
    const scanned = scans[documentNumber - 1];

    if (!scanned) {
      throw new TextPlacementError(
        `${where}.document: the envelope has ${String(pdfs.length)} document(s).`,
      );
    }

    if (requested.document === undefined && pdfs.length > 1) {
      throw new TextPlacementError(
        `${where}.document: say which document to search, as there is more than one.`,
      );
    }

    const wanted = anchor.occurrence ?? 1;
    const pattern = anchorPattern(anchor.text);
    let seen = 0;
    let found: PlacedField | null = null;

    for (const [pageIndex, page] of scanned.entries()) {
      if (requested.page !== undefined && requested.page !== pageIndex + 1) {
        continue;
      }

      for (const match of findMatches(page.runs, pattern)) {
        seen += 1;

        if (seen === wanted) {
          const size = {
            height: requested.height ?? DEFAULT_SIZES[requested.type].height,
            width: requested.width ?? DEFAULT_SIZES[requested.type].width,
          };
          const box = toPageBox(match.quad, page.transform, page.page);

          found = {
            document: documentNumber,
            groupId: requested.groupId,
            ...size,
            label: requested.label,
            options: requested.options,
            page: pageIndex + 1,
            required: requested.required,
            signer: requested.signer,
            type: requested.type,
            ...placeBeside(box, size, anchor),
          };
          break;
        }
      }

      if (found) {
        break;
      }
    }

    if (!found) {
      const hasText = scanned.some((page) => page.runs.length > 0);

      throw new TextPlacementError(
        `${where}.anchor: ${
          seen > 0
            ? `the text "${anchor.text}" was found ${String(seen)} time(s), fewer than occurrence ${String(wanted)}.`
            : hasText
              ? `the text "${anchor.text}" was not found in the document.`
              : `the document has no text to search (a scanned image has none).`
        }`,
      );
    }

    fields.push(found);
  }

  // Text tags, document by document, page by page, in reading order.
  const covers: Array<Array<{ page: number; quad: Quad }>> = pdfs.map(() => []);

  if (input.textTags) {
    for (const [documentIndex, scanned] of scans.entries()) {
      for (const [pageIndex, page] of scanned.entries()) {
        for (const match of findMatches(page.runs, TAG_PATTERN)) {
          const where = `textTags: ${pdfs[documentIndex]!.filename}, page ${String(pageIndex + 1)}, ${match.text}`;
          let tag;

          try {
            tag = parseTag(match.text.slice(2, -2));
          } catch (error) {
            if (error instanceof TextTagError) {
              throw new TextPlacementError(`${where}: ${error.message}`);
            }

            throw error;
          }

          if (!tag) {
            continue;
          }

          if (!knownSigners.has(tag.signer)) {
            throw new TextPlacementError(
              `${where}: no signer has the ref "${tag.signer}".`,
            );
          }

          const size = {
            height: tag.height ?? DEFAULT_SIZES[tag.type].height,
            width: tag.width ?? DEFAULT_SIZES[tag.type].width,
          };
          const box = toPageBox(match.quad, page.transform, page.page);

          fields.push({
            document: documentIndex + 1,
            groupId: tag.groupId,
            ...size,
            label: tag.label,
            options: tag.options,
            page: pageIndex + 1,
            required: tag.required,
            signer: tag.signer,
            type: tag.type,
            ...placeBeside(box, size, { position: "over" }),
          });
          covers[documentIndex]!.push(
            ...match.pieces.map((quad) => ({ page: pageIndex + 1, quad })),
          );
        }
      }
    }
  }

  if (fields.length === 0) {
    throw new TextPlacementError(
      "textTags: no [[type:signer]] tags were found in the documents, and no fields were given.",
    );
  }

  if (fields.length > maxFields) {
    throw new TextPlacementError(
      `fields: at most ${String(maxFields)}, and the tags make ${String(fields.length)}.`,
    );
  }

  const covered: PlacementPdf[] = [];

  for (const [index, pdf] of pdfs.entries()) {
    const boxes = covers[index]!;

    covered.push(
      boxes.length === 0
        ? pdf
        : { ...pdf, body: await coverBoxes(pdf.body, boxes) },
    );
  }

  return { fields, pdfs: covered };
}
