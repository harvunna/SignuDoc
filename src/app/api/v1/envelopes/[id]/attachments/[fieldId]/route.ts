import { apiError } from "@/lib/api/http";
import { handleApi } from "@/lib/api/route";
import { getDb, queryOne } from "@/lib/db/connection";
import {
  createAttachmentDownloadResponse,
  getEnvelopeAttachmentFile,
} from "@/lib/signer-attachments";
import { buildContentDisposition } from "@/lib/services/storage";

type Context = { params: Promise<{ fieldId: string; id: string }> };

// Signly: a file a signer attached, once they signed. A key reaches only
// its owner's own envelopes.
export async function GET(request: Request, context: Context) {
  const { fieldId, id } = await context.params;

  return handleApi(
    request,
    "read",
    "api_envelope_attachment_failure",
    async ({ actor }) => {
      const database = getDb();
      const owned = await queryOne<{ id: string }>(
        database,
        `SELECT id FROM envelopes WHERE id = $1 AND user_id = $2`,
        [id, actor.userId],
      );
      const file = owned
        ? await getEnvelopeAttachmentFile(id, fieldId, database)
        : null;

      if (!file) {
        return apiError(404, "not_found", "Attachment not found.");
      }

      return createAttachmentDownloadResponse(file, undefined, (name) =>
        buildContentDisposition(name, "attachment"),
      );
    },
  );
}
