// Where sign-in may send someone afterwards, other than their dashboard:
// only the OAuth consent screen, so an app that sent a signed-out person
// there gets them back. Anything else, such as another site's address, is
// ignored, so a sign-in link cannot be made into an open redirect.

const AUTHORIZE_PATH = "/oauth/authorize";

export function safePostSignInPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) {
    return null;
  }

  if (!value.startsWith(AUTHORIZE_PATH)) {
    return null;
  }

  const rest = value.slice(AUTHORIZE_PATH.length);

  if (rest !== "" && !rest.startsWith("?")) {
    return null;
  }

  return /[\\\r\n\t]/.test(value) ? null : value;
}
