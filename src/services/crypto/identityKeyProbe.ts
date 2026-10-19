/**
 * identityKeyProbe — "does this private key belong to this public key?"
 *
 * One ECIES seal+open round trip against the key pair itself. This is the only
 * local proof the app has that a surviving private key still corresponds to a
 * public key it did not generate (a server-held identity key after reinstall,
 * or its own cached pair before asking a peer to re-wrap a group key).
 *
 * ## Why both calls sit in ONE try (#913)
 *
 * `ecies_seal` derives the public key from the private key and refuses up
 * front when the two disagree:
 *
 *   SignalError::InvalidArgument {
 *     reason: "ecies_seal: sender_public_key does not match sender_private_key"
 *   }
 *
 * So on a genuine mismatch the FAILURE HAPPENS IN SEAL, and `ecies_open` is
 * never reached. The previous version of this check wrapped only the open call,
 * which made its mismatch branch unreachable: every real mismatch escaped as a
 * throw and was read as a transient failure.
 *
 * ## Fail-safe taxonomy
 *
 * `'mismatch'` is returned ONLY for `InvalidArgument` whose `inner.reason`
 * contains "does not match". Everything else — `InvalidKey`, `InvalidMessage`,
 * `InternalError`, a bare `Error`, a native-module failure — is RETHROWN, so
 * the caller treats it as "unknown, try later" rather than as proof.
 *
 * That asymmetry is deliberate: a `'mismatch'` is the one answer that lets
 * `identityRestoreService` DELETE a surviving Keychain identity key, and lets
 * `groupKeyRecovery` latch its session kill switch. An ambiguous failure must
 * never do either.
 *
 * ## Reason-string contract
 *
 * The literal "does not match" is copied from
 * `packages/orbital-signal/rust/orbital_signal/src/ecies.rs` and is pinned by
 * `__tests__/eciesReasonContract.test.ts`. A libsignal/orbital_signal bump must
 * re-verify it (see the bump playbook): if the wording changes, this probe
 * degrades to "always throws", i.e. 'deferred' / 'failed' — safe, not silent
 * key deletion.
 *
 * @module identityKeyProbe
 */

import { eciesSeal, eciesOpen, SignalError_Tags } from 'orbital-signal';
import { encodeUTF8, toArrayBuffer, getSecureRandom } from './utils';

/** Fixed domain-separation context for the ECIES round-trip proof. */
const VERIFY_PROBE_CONTEXT = 'identity-verify-probe';

/**
 * Substring of the `ecies_seal` InvalidArgument reason that proves the sender
 * public key does not belong to the sender private key. Matched as a substring
 * so the `ecies_seal:` prefix and any future suffix stay tolerated.
 */
const MISMATCH_REASON_FRAGMENT = 'does not match';

/**
 * Definite answers only. Anything the probe cannot decide is thrown, never
 * folded into a third enum value — callers must handle "unknown" explicitly.
 */
export type IdentityKeyProbeResult = 'match' | 'mismatch';

function isDefiniteMismatch(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as { tag?: unknown; inner?: { reason?: unknown } };
  if (e.tag !== SignalError_Tags.InvalidArgument) return false;
  const reason = e.inner?.reason;
  return typeof reason === 'string' && reason.includes(MISMATCH_REASON_FRAGMENT);
}

/**
 * Prove (or disprove) that `privateKey` is the secret half of `publicKey`.
 *
 * @param privateKey - 32-byte Curve25519 private key, raw bytes.
 * @param publicKey  - 33-byte Signal-format public key (0x05 prefix).
 * @returns `'match'` when the round trip succeeds, `'mismatch'` on the single
 *          definite seal-side mismatch error.
 * @throws Any other error, unchanged. Callers MUST treat a throw as unknown.
 */
export function probeIdentityKeyPair(
  privateKey: ArrayBuffer,
  publicKey: ArrayBuffer,
): IdentityKeyProbeResult {
  const contextBytes = toArrayBuffer(encodeUTF8(VERIFY_PROBE_CONTEXT));
  const plaintextBuf = toArrayBuffer(getSecureRandom(32));

  try {
    // Seal to self: recipient, sender-private and sender-public are all ours.
    const sealed = eciesSeal(
      plaintextBuf,
      contextBytes,
      publicKey, // recipient = our own public key
      privateKey, // sender private = our private key
      publicKey, // sender public = our own public key
    );
    // Open with our private key, expecting ourselves as sender.
    eciesOpen(sealed, contextBytes, privateKey, publicKey);
    return 'match';
  } catch (err: unknown) {
    if (isDefiniteMismatch(err)) return 'mismatch';
    throw err;
  }
}
