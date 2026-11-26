import { degrees, PDFDocument, rgb } from "pdf-lib";

import { fieldTypes } from "../types/domain.ts";

// GCM eSign: fields placed by text instead of by coordinates.
//
// Two ways, both read from the uploaded PDFs before the envelope is made:
//
//   Text tags   [[signature:client]]  typed in the document itself. Each
//               becomes a field where it stands, and the tag is covered with
//               white so it does not show in what signers see or in the
//               sealed copy.
//   Anchors     a field in the request that says "next to the words
//               Signature of Client", for documents that have no tags.
//
// Everything below the "pure" line works on text items and is tested with
// made-up ones; scanPdf reads the real items with pdf.js.

export type FieldTypeName = (typeof fieldTypes)[number];

/** A run of text as pdf.js reports it, in the page's own coordinates. */
export type TextRun = {
  /** Distance the text advances along its direction, in points. */
  advance: number;
  /** Direction of the text (the first two numbers of its matrix). */
  dirX: number;
  dirY: number;
  /** Font height in points. */
  height: number;
  hasEOL: boolean;
  str: string;
  /** Where the text starts (its baseline), in user space. */
  x: number;
  y: number;
};

type Point = { x: number; y: number };

/** The four corners of a part of a text run, in user space. */
export type Quad = [Point, Point, Point, Point];

export type TextMatch = {
  /** The matched text. */
  text: string;
  /** Corners of the first and last runs it touches, merged. */
  quad: Quad;
  /** The same corners, one box per run, for covering the match up. */
  pieces: Quad[];
};

const DESCENT = 0.25;

export const DEFAULT_SIZES: Record<
  FieldTypeName,
  { height: number; width: number }
> = {
  attachment: { height: 0.05, width: 0.3 },
  checkbox: { height: 0.025, width: 0.025 },
  date: { height: 0.03, width: 0.16 },
  dropdown: { height: 0.03, width: 0.25 },
  initials: { height: 0.04, width: 0.08 },
  name: { height: 0.03, width: 0.25 },
  number: { height: 0.03, width: 0.16 },
  radio: { height: 0.025, width: 0.025 },
  signature: { height: 0.05, width: 0.25 },
  text: { height: 0.03, width: 0.25 },
};

function pieceQuad(run: TextRun, start: number, end: number): Quad {
  const length = Math.max(run.str.length, 1);
  const from = (run.advance * start) / length;
  const to = (run.advance * end) / length;
  const norm = Math.hypot(run.dirX, run.dirY) || 1;
  const dx = run.dirX / norm;
  const dy = run.dirY / norm;
  // Up from the baseline is the direction turned a quarter.
  const ux = -dy;
  const uy = dx;
  const below = run.height * DESCENT;
  const above = run.height;
  const at = (along: number, up: number): Point => ({
    x: run.x + dx * along + ux * up,
    y: run.y + dy * along + uy * up,
  });

  return [at(from, -below), at(to, -below), at(to, above), at(from, above)];
}

function mergeQuads(quads: readonly Quad[]): Quad {
  const points = quads.flat();
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const bottom = Math.min(...ys);
  const top = Math.max(...ys);

  return [
    { x: left, y: bottom },
    { x: right, y: bottom },
    { x: right, y: top },
    { x: left, y: top },
  ];
}

/** The page's text as one string, and where each character came from. */
function joinRuns(runs: readonly TextRun[]) {
  let text = "";
  const owners: number[] = [];
  const starts: number[] = [];

  runs.forEach((run, index) => {
    starts.push(text.length);

    for (let at = 0; at < run.str.length; at += 1) {
      owners.push(index);
    }

    text += run.str;

    if (run.hasEOL) {
      owners.push(index);
      text += "\n";
    }
  });

  return { owners, starts, text };
}

/** Every match of the pattern in the page's text, with where it is. */
export function findMatches(
  runs: readonly TextRun[],
  pattern: RegExp,
): TextMatch[] {
  const { owners, starts, text } = joinRuns(runs);
  const matches: TextMatch[] = [];
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;

  for (const found of text.matchAll(new RegExp(pattern.source, flags))) {
    const start = found.index;
    const end = start + found[0].length;
    const pieces: Quad[] = [];
    let at = start;

    while (at < end) {
      const owner = owners[at]!;
      const run = runs[owner]!;
      let last = at;

      while (last < end && owners[last] === owner) {
        last += 1;
      }

      const runStart = starts[owner]!;

      const from = Math.min(at - runStart, run.str.length);
      const to = Math.min(last - runStart, run.str.length);

      if (to > from) {
        pieces.push(pieceQuad(run, from, to));
      }

      at = last;
    }

    if (pieces.length > 0) {
      matches.push({ pieces, quad: mergeQuads(pieces), text: found[0] });
    }
  }

  return matches;
}

/** Words to find, however the PDF spaces them, any capitals. */
export function anchorPattern(text: string): RegExp {
  const escaped = text
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");

  return new RegExp(escaped, "gi");
}

export type ParsedTag = {
  groupId?: string;
  height?: number;
  label?: string;
  options?: string[];
  required: boolean;
  signer: string;
  type: FieldTypeName;
  width?: number;
};

export class TextTagError extends Error {}

/**
 * Reads what is inside [[ and ]]: type:signer, then any of optional,
 * label=..., options=a|b|c, group=..., w=0.3, h=0.05. Returns null for text
 * that is not meant as a tag (no colon, or not starting with a word).
 */
export function parseTag(inside: string): ParsedTag | null {
  if (!inside.includes(":")) {
    return null;
  }

  const [typePart, signerPart, ...rest] = inside.split(":");
  const type = (typePart ?? "").trim().toLowerCase();

  if (!/^[a-z]+$/.test(type)) {
    return null;
  }

  if (!(fieldTypes as readonly string[]).includes(type)) {
    throw new TextTagError(
      `"${type}" is not a field type. Use one of ${fieldTypes.join(", ")}.`,
    );
  }

  const signer = (signerPart ?? "").trim();

  if (!/^[A-Za-z0-9._-]{1,64}$/.test(signer)) {
    throw new TextTagError(
      `the tag needs the signer's ref after the type, like [[${type}:client]].`,
    );
  }

  const tag: ParsedTag = {
    required: true,
    signer,
    type: type as FieldTypeName,
  };

  for (const part of rest) {
    const option = part.trim();

    if (option === "") {
      continue;
    }

    if (option === "optional") {
      tag.required = false;
    } else if (option === "required") {
      tag.required = true;
    } else {
      const equals = option.indexOf("=");
      const key = equals === -1 ? option : option.slice(0, equals).trim();
      const value = equals === -1 ? "" : option.slice(equals + 1).trim();

      if (key === "label" && value) {
        tag.label = value.slice(0, 120);
      } else if (key === "group" && value) {
        tag.groupId = value.slice(0, 64);
      } else if (key === "options" && value) {
        tag.options = value.split("|").map((choice) => choice.trim());
      } else if ((key === "w" || key === "h") && Number(value) > 0) {
        const size = Number(value);

        if (size > 1) {
          throw new TextTagError(`${key}=${value} must be between 0 and 1.`);
        }

        tag[key === "w" ? "width" : "height"] = size;
      } else {
        throw new TextTagError(`"${option}" is not a tag option.`);
      }
    }
  }

  if (tag.type === "radio" && !tag.groupId) {
    throw new TextTagError("a radio tag needs group=name.");
  }

  if (tag.type === "dropdown" && (tag.options?.length ?? 0) < 2) {
    throw new TextTagError("a dropdown tag needs options=a|b (two or more).");
  }

  return tag;
}

export const TAG_PATTERN = /\[\[([^[\]\n]{1,300})\]\]/g;

export type PageSize = { height: number; width: number };

/** A box on a page as fractions of its shown width and height. */
export type PageBox = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

export type AnchorOptions = {
  offsetX?: number;
  offsetY?: number;
  position?: "below" | "over" | "right";
};

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

/**
 * Where a field of this size goes for a box of text: beside it (the
 * default), below it, or on top of it. Always inside the page.
 */
export function placeBeside(
  box: PageBox,
  size: { height: number; width: number },
  { offsetX = 0, offsetY = 0, position = "right" }: AnchorOptions = {},
) {
  const middle = (box.top + box.bottom) / 2;
  let x = box.left;
  let y = middle - size.height / 2;

  if (position === "right") {
    x = box.right + 0.01;
  } else if (position === "below") {
    y = box.bottom + 0.005;
  }

  return {
    x: clamp(x + offsetX, 0, 1 - size.width),
    y: clamp(y + offsetY, 0, 1 - size.height),
  };
}

type Matrix = [number, number, number, number, number, number];

/** Bounding box of user-space corners on the shown page, as fractions. */
export function toPageBox(
  quad: Quad,
  viewportTransform: Matrix,
  page: PageSize,
): PageBox {
  const [a, b, c, d, e, f] = viewportTransform;
  const shown = quad.map((point) => ({
    x: a * point.x + c * point.y + e,
    y: b * point.x + d * point.y + f,
  }));
  const xs = shown.map((point) => point.x / page.width);
  const ys = shown.map((point) => point.y / page.height);

  return {
    bottom: Math.max(...ys),
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
  };
}

export type ScannedPage = {
  /** Shown size in points. */
  page: PageSize;
  runs: TextRun[];
  /** Maps user space to the shown page (y down). */
  transform: Matrix;
};

type PdfJsItem = {
  hasEOL?: boolean;
  height?: number;
  str?: string;
  transform?: number[];
  width?: number;
};

/** Reads each page's text runs with pdf.js. A PDF it cannot read has none. */
export async function scanPdf(body: Uint8Array): Promise<ScannedPage[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let document;

  try {
    document = await pdfjs.getDocument({
      data: new Uint8Array(body),
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
  } catch {
    return [];
  }

  const pages: ScannedPage[] = [];

  try {
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const runs: TextRun[] = [];

      for (const item of content.items as PdfJsItem[]) {
        const matrix = item.transform;

        if (typeof item.str !== "string" || !matrix || matrix.length < 6) {
          continue;
        }

        const dirX = matrix[0]!;
        const dirY = matrix[1]!;

        runs.push({
          advance: item.width ?? 0,
          dirX,
          dirY,
          hasEOL: item.hasEOL === true,
          height: item.height ?? Math.hypot(matrix[2]!, matrix[3]!),
          str: item.str,
          x: matrix[4]!,
          y: matrix[5]!,
        });
      }

      pages.push({
        page: { height: viewport.height, width: viewport.width },
        runs,
        transform: viewport.transform as Matrix,
      });
    }
  } finally {
    await document.destroy();
  }

  return pages;
}

/** Covers each box with white, on its page. Returns the changed PDF. */
export async function coverBoxes(
  body: Uint8Array,
  boxes: ReadonlyArray<{ page: number; quad: Quad }>,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(body, { ignoreEncryption: false });
  const pages = pdf.getPages();

  for (const { page: number, quad } of boxes) {
    const page = pages[number - 1];

    if (!page) {
      continue;
    }

    const [first, second, , fourth] = quad;
    const width = Math.hypot(second.x - first.x, second.y - first.y);
    const height = Math.hypot(fourth.x - first.x, fourth.y - first.y);
    const angle =
      (Math.atan2(second.y - first.y, second.x - first.x) * 180) / Math.PI;

    page.drawRectangle({
      borderWidth: 0,
      color: rgb(1, 1, 1),
      height: height + 1,
      rotate: degrees(angle),
      width: width + 1,
      x: first.x,
      y: first.y,
    });
  }

  return pdf.save();
}
