"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  FileTextIcon,
  UploadIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  startTransition,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import { PageHeader } from "@/components/shared/page-header";
import { StepIndicator } from "@/components/shared/step-indicator";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { cacheDraftPdfBlob } from "@/lib/draft-pdf-cache";
import {
  renderPdfThumbnail,
  uploadEnvelopeThumbnail,
} from "@/lib/pdf-thumbnail";
import {
  describePdfPreviewFailure,
  PREVIEW_UNAVAILABLE_MESSAGE,
} from "@/lib/pdf-preview-error";
import { assertPdfPreviewRenderable } from "@/lib/pdfjs-client";
import { type CreateEnvelopeResponse } from "@/lib/schemas/envelope";

const envelopeSteps = ["Upload", "Signers", "Place fields", "Review"];
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
// GCM eSign: an envelope may hold several PDFs. Together they keep to the
// same 20 MB as one, because the server joins them into one PDF.
const MAX_DOCUMENTS = 10;

type UploadErrorCode =
  | "invalid-type"
  | "preview-unavailable"
  | "too-large"
  | "too-large-together"
  | "too-many-documents";

type UploadSummary = {
  file: File;
  fileName: string;
  /** Tells the rows apart: two files may share a name. */
  id: string;
  sizeLabel: string;
};

const errorMessageMap: Record<UploadErrorCode, string> = {
  "invalid-type": "Only PDF files are supported. Please upload a valid PDF.",
  "preview-unavailable": PREVIEW_UNAVAILABLE_MESSAGE,
  "too-large": "This file exceeds the 20 MB limit.",
  "too-large-together":
    "Together these files exceed the 20 MB limit. Remove a file or make one smaller.",
  "too-many-documents": `An envelope can hold up to ${String(MAX_DOCUMENTS)} documents.`,
};

const knownTitleSuggestions: Record<string, string> = {
  "nda-clientbravo-2026.pdf": "NDA - Client Bravo",
  "nda-client-bravo-2026.pdf": "NDA - Client Bravo",
  "vendor-agreement-two-signer.pdf": "Vendor agreement - two signer flow",
};

function formatFileSize(sizeInBytes: number) {
  const sizeInMegabytes = sizeInBytes / (1024 * 1024);

  if (sizeInMegabytes >= 1) {
    return `${sizeInMegabytes.toFixed(1)} MB`;
  }

  return `${Math.max(1, Math.round(sizeInBytes / 1024))} KB`;
}

function makeTitleSuggestion(fileName: string) {
  return fileName
    .replace(/\.pdf$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTitleSuggestion(fileName: string): string {
  const normalizedName = fileName.toLowerCase();
  const knownTitleSuggestion = knownTitleSuggestions[normalizedName];

  if (knownTitleSuggestion) {
    return knownTitleSuggestion;
  }

  return makeTitleSuggestion(fileName);
}

function isClientVisiblePdf(file: File): boolean {
  const normalizedName = file.name.toLowerCase();

  return (
    normalizedName.endsWith(".pdf") &&
    (file.type.length === 0 || file.type === "application/pdf")
  );
}

function UploadShellLayout({
  canContinue,
  errorMessage,
  isBusy,
  isDragActive,
  isSubmitting = false,
  onDropzoneKeyDown,
  onMoveFile,
  onOpenFilePicker,
  onRemoveFile,
  onTitleChange,
  onContinue,
  previewUrl,
  summaries,
  title,
}: {
  canContinue: boolean;
  errorMessage: string | null;
  isBusy: boolean;
  isDragActive: boolean;
  isSubmitting?: boolean;
  onContinue?: () => void;
  onDropzoneKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onMoveFile: (id: string, offset: -1 | 1) => void;
  onOpenFilePicker: () => void;
  onRemoveFile: (id: string) => void;
  onTitleChange: (event: ChangeEvent<HTMLInputElement>) => void;
  /** A picture of the first page of the first file. */
  previewUrl: string | null;
  summaries: readonly UploadSummary[];
  title: string;
}) {
  const hasSeveral = summaries.length > 1;

  const dropzoneClasses = isBusy
    ? "border-(--accent) bg-(--accent-softer)"
    : errorMessage
      ? "border-[rgba(180,35,24,0.4)] bg-(--danger-soft)"
      : isDragActive
        ? "border-(--accent) bg-(--accent-softer)"
        : "border-(--border-strong) bg-(--surface) hover:border-(--accent) hover:bg-(--accent-softer)";

  return (
    <div className="space-y-5">
      <PageHeader
        action={
          <Link className="btn-quiet min-h-11 px-4" href="/templates">
            Start from a template
          </Link>
        }
        description="Step 1 of 4 - Upload document"
        title="New envelope"
      />

      <StepIndicator current={1} steps={envelopeSteps} />

      <section
        className="panel p-5 sm:p-8"
        data-animate="enter"
        data-animate-delay="2"
      >
        <div className="space-y-6">
          <FieldShell
            label="Envelope title"
            onChange={onTitleChange}
            placeholder="e.g., NDA - Client Bravo"
            readOnly={false}
            value={title}
          />

          <div
            aria-busy={isBusy}
            aria-label="Document upload dropzone"
            className={cn(
              "cursor-pointer rounded-[1.25rem] border-2 border-dashed px-6 py-10 text-center transition sm:px-10 sm:py-12",
              dropzoneClasses,
            )}
            onClick={onOpenFilePicker}
            onDragLeave={isBusy ? undefined : () => undefined}
            onDragOver={undefined}
            onDrop={undefined}
            onKeyDown={onDropzoneKeyDown}
            role="button"
            tabIndex={0}
          >
            <div className="mx-auto flex max-w-xl flex-col items-center gap-4">
              {isBusy ? (
                <>
                  <div
                    aria-label="Upload progress"
                    className="h-2 w-full max-w-sm overflow-hidden rounded-full bg-white"
                    role="progressbar"
                  >
                    <div className="h-full w-2/3 animate-pulse rounded-full bg-(--accent)" />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-lg font-bold tracking-[-0.02em] text-(--fg)">
                      Uploading...
                    </p>
                    <p className="text-sm leading-6 text-(--secondary)">
                      Validating the PDF before you continue to signer setup.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-(--accent-soft) text-(--accent)">
                    <UploadIcon
                      aria-hidden="true"
                      className="size-5"
                      strokeWidth={2.2}
                    />
                  </span>
                  <div className="space-y-1.5">
                    <p className="text-lg font-bold tracking-[-0.02em] text-(--fg)">
                      {summaries.length > 0
                        ? "Drag and drop another PDF here"
                        : "Drag and drop your PDFs here"}
                    </p>
                    <p className="text-sm text-(--secondary)">
                      or{" "}
                      <span className="font-bold text-(--accent-ink) underline decoration-[rgb(var(--accent-rgb)/0.35)] underline-offset-4">
                        click to browse
                      </span>
                    </p>
                  </div>
                  <p className="text-[0.8125rem] font-medium text-(--tertiary)">
                    {`PDF only - up to ${String(MAX_DOCUMENTS)} files, 20 MB in total`}
                  </p>
                </>
              )}
            </div>
          </div>

          {errorMessage ? (
            <div
              className="rounded-2xl bg-(--danger-soft) px-5 py-4"
              role="alert"
            >
              <p className="text-sm font-semibold text-(--danger)">
                {errorMessage}
              </p>
            </div>
          ) : null}

          {summaries.length > 0 ? (
            <section aria-label="Documents" className="space-y-2">
              {hasSeveral ? (
                <p className="text-[0.8125rem] text-(--secondary)">
                  {`${String(summaries.length)} documents. Signers see them in this order, one after the other.`}
                </p>
              ) : null}
              <ol className="space-y-2">
                {summaries.map((summary, index) => (
                  <li
                    className="well flex items-center gap-4 p-3.5 pr-4"
                    key={summary.id}
                  >
                    <span className="flex h-[4.5rem] w-14 shrink-0 items-center justify-center">
                      {index === 0 && previewUrl ? (
                        // A blob: URL drawn in this browser from the chosen file.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          alt=""
                          className="max-h-full max-w-full rounded-[0.375rem] bg-white shadow-[0_1px_2px_rgba(28,29,43,0.08),0_4px_10px_rgba(28,29,43,0.10)] ring-1 ring-[rgba(28,29,43,0.06)]"
                          src={previewUrl}
                        />
                      ) : (
                        <span className="inline-flex size-11 items-center justify-center rounded-xl bg-white text-(--accent)">
                          <FileTextIcon aria-hidden="true" className="size-5" />
                        </span>
                      )}
                    </span>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="truncate text-sm font-bold text-(--fg)">
                        {hasSeveral
                          ? `${String(index + 1)}. ${summary.fileName}`
                          : summary.fileName}
                      </p>
                      <p className="text-[0.8125rem] text-(--tertiary)">
                        {summary.sizeLabel}
                      </p>
                    </div>
                    {hasSeveral ? (
                      <div className="flex shrink-0 gap-1">
                        <Button
                          aria-label={`Move ${summary.fileName} up`}
                          disabled={isBusy || index === 0}
                          onClick={() => onMoveFile(summary.id, -1)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <ArrowUpIcon aria-hidden="true" className="size-4" />
                        </Button>
                        <Button
                          aria-label={`Move ${summary.fileName} down`}
                          disabled={isBusy || index === summaries.length - 1}
                          onClick={() => onMoveFile(summary.id, 1)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <ArrowDownIcon
                            aria-hidden="true"
                            className="size-4"
                          />
                        </Button>
                      </div>
                    ) : null}
                    <Button
                      aria-label={
                        hasSeveral ? `Remove ${summary.fileName}` : undefined
                      }
                      disabled={isBusy}
                      onClick={() => onRemoveFile(summary.id)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <div className="flex justify-end">
            <ShellButton
              disabled={!canContinue}
              loading={isSubmitting}
              onClick={onContinue}
            >
              Next -&gt;
            </ShellButton>
          </div>
        </div>
      </section>
    </div>
  );
}

// Sends each PDF straight to Vercel Blob with a signed URL from
// /api/uploads, then tells the app where they are, in order. The Blob SDK is
// loaded only when used. One file is sent in the shape used before several
// were possible.
async function createDraftFromDirectUpload(input: {
  files: readonly File[];
  title: string;
  uploadPrefix: string;
}) {
  const { uploadPresigned } = await import("@vercel/blob/client");
  const uploads: Array<{ filename: string; uploadKey: string }> = [];

  // One at a time: each needs its own signed URL, and the upload
  // authorisation is rate limited.
  for (const file of input.files) {
    const uploadKey = `${input.uploadPrefix}${crypto.randomUUID()}.pdf`;

    await uploadPresigned(uploadKey, file, {
      access: "private",
      contentType: "application/pdf",
      handleUploadUrl: "/api/uploads",
    });
    uploads.push({ filename: file.name, uploadKey });
  }

  return fetch("/api/envelopes", {
    body: JSON.stringify(
      uploads.length === 1
        ? { ...uploads[0], title: input.title }
        : { documents: uploads, title: input.title },
    ),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

async function createDraftFromForm(input: {
  files: readonly File[];
  title: string;
}) {
  const formData = new FormData();

  for (const file of input.files) {
    formData.append("file", file);
  }

  formData.append("title", input.title);

  return fetch("/api/envelopes", {
    body: formData,
    method: "POST",
  });
}

type UploadShellProps = {
  /**
   * Where this user's browser may upload directly, ending in a slash, or
   * null when uploads go through the app.
   */
  directUploadPrefix?: string | null;
};

export function UploadShell({ directUploadPrefix = null }: UploadShellProps) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [summaries, setSummaries] = useState<UploadSummary[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCreatingDraft, setIsCreatingDraft] = useState(false);
  const [autoFilledTitle, setAutoFilledTitle] = useState<string | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // The first page of the first file as a small picture: shown beside the
  // file name here, then saved as the envelope's dashboard thumbnail.
  const thumbnailRef = useRef<Promise<Blob | null> | null>(null);
  const thumbnailFileRef = useRef<File | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  function startThumbnail(file: File | null) {
    // Drawn again only when the first file changes.
    if (file === thumbnailFileRef.current) {
      return;
    }

    thumbnailFileRef.current = file;
    setPreviewUrl(null);

    if (!file) {
      thumbnailRef.current = null;
      return;
    }

    const thumbnail = file
      .arrayBuffer()
      .then((buffer) => renderPdfThumbnail(new Uint8Array(buffer)))
      .catch(() => null);

    thumbnailRef.current = thumbnail;

    void thumbnail.then((blob) => {
      if (blob && thumbnailRef.current === thumbnail) {
        setPreviewUrl(URL.createObjectURL(blob));
      }
    });
  }

  async function parseResponse<T>(
    response: Response,
  ): Promise<{ data: T | null; error: string | null }> {
    const payload = (await response.json().catch(() => null)) as
      { error?: string } | T | null;

    if (!response.ok) {
      return {
        data: null,
        error:
          payload && typeof payload === "object" && "error" in payload
            ? (payload.error ?? "Something went wrong. Please try again.")
            : "Something went wrong. Please try again.",
      };
    }

    return {
      data: payload as T,
      error: null,
    };
  }

  // Adds the chosen files after any already chosen. A file that would be
  // refused is left out and the reason shown; the rest are still added.
  function addFiles(files: readonly File[]) {
    setIsDragActive(false);

    if (files.length === 0) {
      return;
    }

    const next = [...summaries];
    let problem: UploadErrorCode | null = null;
    let totalBytes = next.reduce((sum, entry) => sum + entry.file.size, 0);

    for (const file of files) {
      if (!isClientVisiblePdf(file)) {
        problem = "invalid-type";
        continue;
      }

      if (file.size > MAX_FILE_SIZE_BYTES) {
        problem = "too-large";
        continue;
      }

      if (next.length >= MAX_DOCUMENTS) {
        problem = "too-many-documents";
        break;
      }

      if (totalBytes + file.size > MAX_FILE_SIZE_BYTES) {
        problem = "too-large-together";
        continue;
      }

      totalBytes += file.size;
      next.push({
        file,
        fileName: file.name,
        id: crypto.randomUUID(),
        sizeLabel: formatFileSize(file.size),
      });
    }

    setErrorMessage(problem ? errorMessageMap[problem] : null);
    applySelection(next);
  }

  function applySelection(next: UploadSummary[]) {
    setSummaries(next);
    startThumbnail(next[0]?.file ?? null);

    if (next.length === 0) {
      setTitle((currentTitle) =>
        autoFilledTitle && currentTitle === autoFilledTitle ? "" : currentTitle,
      );
      setAutoFilledTitle(null);
      return;
    }

    const titleSuggestion = getTitleSuggestion(next[0]!.fileName);

    // The title follows the first file for as long as the sender has not
    // typed one of their own.
    if (
      title.trim().length === 0 ||
      (autoFilledTitle !== null && title === autoFilledTitle)
    ) {
      setTitle(titleSuggestion);
      setAutoFilledTitle(titleSuggestion);
    }
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function handleRemoveFile(id: string) {
    setErrorMessage(null);
    applySelection(summaries.filter((entry) => entry.id !== id));
  }

  function handleMoveFile(id: string, offset: -1 | 1) {
    const index = summaries.findIndex((entry) => entry.id === id);
    const target = index + offset;

    if (index < 0 || target < 0 || target >= summaries.length) {
      return;
    }

    const next = [...summaries];

    [next[index], next[target]] = [next[target]!, next[index]!];
    applySelection(next);
  }

  function handleTitleChange(event: ChangeEvent<HTMLInputElement>) {
    const nextTitle = event.target.value;
    setTitle(nextTitle);

    if (autoFilledTitle && nextTitle !== autoFilledTitle) {
      setAutoFilledTitle(null);
    }
  }

  function openFilePicker() {
    if (isCreatingDraft) {
      return;
    }

    fileInputRef.current?.click();
  }

  function handleDropzoneKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openFilePicker();
    }
  }

  async function handleContinue() {
    if (
      isCreatingDraft ||
      summaries.length === 0 ||
      title.trim().length === 0
    ) {
      return;
    }

    const files = summaries.map((entry) => entry.file);

    setIsCreatingDraft(true);
    setErrorMessage(null);

    // Taken now, with the file. The file can still be removed and another
    // chosen while the draft is being created, and that one's picture must
    // not end up on this draft.
    const thumbnailForDraft = thumbnailRef.current;

    try {
      for (const file of files) {
        try {
          await assertPdfPreviewRenderable(file);
        } catch (error) {
          console.error(
            "Failed to validate the PDF preview before draft creation.",
            error,
          );
          setErrorMessage(
            files.length > 1
              ? `${file.name}: ${describePdfPreviewFailure(error)}`
              : describePdfPreviewFailure(error),
          );
          setIsCreatingDraft(false);
          return;
        }
      }

      const draftInput = { files, title: title.trim() };
      const response = directUploadPrefix
        ? await createDraftFromDirectUpload({
            ...draftInput,
            uploadPrefix: directUploadPrefix,
          })
        : await createDraftFromForm(draftInput);
      const payload = await parseResponse<CreateEnvelopeResponse>(response);

      if (!payload.data || payload.error) {
        setErrorMessage(
          payload.error ?? "Something went wrong. Please try again.",
        );

        // A refused single file is cleared, as before. With several, the
        // message names the file and the sender removes it themselves.
        if (response.status === 400 && files.length === 1) {
          setSummaries([]);
          startThumbnail(null);
        }

        setIsCreatingDraft(false);
        return;
      }

      try {
        // Only one file is the envelope's PDF as it is. Several are joined
        // on the server, and the builder fetches that.
        if (files.length === 1) {
          await cacheDraftPdfBlob(payload.data.envelopeId, files[0]!);
        }
      } catch (error) {
        console.error(
          "Failed to cache the uploaded PDF for local preview.",
          error,
        );
      }

      // Not waited for: the dashboard draws one later if this is lost.
      const createdEnvelopeId = payload.data.envelopeId;

      void thumbnailForDraft?.then((thumbnail) =>
        thumbnail
          ? uploadEnvelopeThumbnail(createdEnvelopeId, thumbnail)
          : false,
      );

      const redirectPath = payload.data.redirectPath;

      startTransition(() => {
        router.push(redirectPath);
      });
    } catch {
      setErrorMessage("Something went wrong. Please try again.");
      setIsCreatingDraft(false);
    }
  }

  const canContinue =
    !isCreatingDraft && summaries.length > 0 && title.trim().length > 0;

  return (
    <div
      onDragLeave={() => setIsDragActive(false)}
      onDragOver={(event) => {
        event.preventDefault();
        if (!isCreatingDraft) {
          setIsDragActive(true);
        }
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();

        if (isCreatingDraft) {
          return;
        }

        addFiles(Array.from(event.dataTransfer.files ?? []));
      }}
    >
      <input
        accept=".pdf,application/pdf"
        aria-label="Upload PDF"
        className="sr-only"
        multiple
        onChange={handleInputChange}
        ref={fileInputRef}
        type="file"
      />
      <UploadShellLayout
        canContinue={canContinue}
        errorMessage={errorMessage}
        isBusy={isCreatingDraft}
        isDragActive={isDragActive}
        isSubmitting={isCreatingDraft}
        onContinue={handleContinue}
        onDropzoneKeyDown={handleDropzoneKeyDown}
        onMoveFile={handleMoveFile}
        onOpenFilePicker={openFilePicker}
        onRemoveFile={handleRemoveFile}
        onTitleChange={handleTitleChange}
        previewUrl={previewUrl}
        summaries={summaries}
        title={title}
      />
    </div>
  );
}
