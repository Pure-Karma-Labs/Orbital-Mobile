/**
 * Terms of Service policy constants.
 *
 * TERMS_VERSION is informational-only on the client. The server stamps its own
 * authoritative version when recording acceptance. This value is sent on signup
 * for drift logging — if the client and server versions diverge (e.g. a stale
 * client build), the server logs the mismatch but still stamps its own version.
 * A mismatch is non-breaking.
 */

export const TERMS_VERSION = 1;
