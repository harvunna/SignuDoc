import { MAX_JSON_BODY_BYTES, readBodyWithin } from "@/lib/api/body";
import { apiError, apiJson, bodyTooLarge } from "@/lib/api/http";
import { getApiEnvelope } from "@/lib/api/envelopes";
import { applyAccountLimit, handleApi } from "@/lib/api/route";
import { correctSentEnvelopeSigner } from "@/lib/envelopes";

type RouteContext = { params: Promise<{ id: string; signerId: string }> };

/** Corrections of signers: per key, every hour, as in the web app. */
const API_SIGNER_CORRECTION_LIMIT = {
  key: "api-signer-correct",
  limit: 20,
  refusal:
    "This key has corrected too many signers for now. Wait and try again.",
  windowMs: 60 * 60 * 1000,
};

// Signly: corrects the name and/or email of a signer who has not signed or
// declined, on an envelope that is out for signature. Their old link stops
// working; if it is their turn, a new invitation goes to the corrected
// address. The same change as "Correct signer" on the envelope's page,
// with the same signer_corrected audit event.
export async function PATCH(request: Request, context: RouteContext) {
  return handleApi(
    request,
    "write",
    "api_signer_correct_failure",
    async (api) => {
      const limited = await applyAccountLimit(api, API_SIGNER_CORRECTION_LIMIT);

      if (limited) {
        return limited;
      }

      const { id, signerId } = await context.params;
      const raw = await readBodyWithin(request, MAX_JSON_BODY_BYTES);

      if (!raw) {
        return bodyTooLarge();
      }

      let body: unknown = null;

      try {
        body = JSON.parse(new TextDecoder().decode(raw)) as unknown;
      } catch {
        return apiError(400, "invalid_request", "The body is not valid JSON.");
      }

      await correctSentEnvelopeSigner(api.actor.userId, id, signerId, body, {
        ipAddress: api.actor.ipAddress,
        senderEmail: api.actor.email,
        senderName: api.actor.name.trim() ? api.actor.name : api.actor.email,
        userAgent: api.actor.userAgent,
      });

      const envelope = await getApiEnvelope(api.actor.userId, id);

      return envelope
        ? apiJson(envelope)
        : apiError(404, "not_found", "Envelope not found.");
    },
  );
}
