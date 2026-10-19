/// <reference types="node" />

/**
 * Contract test: the ECIES reason strings the TypeScript matchers depend on.
 *
 * Two crypto decisions are made by substring-matching a Rust error reason:
 *
 * 1. `groupKeyErrors.classifyEciesOpenError` picks the failure code — and a
 *    `recipient_mismatch` is what authorises asking the server to NULL this
 *    device's own wrapped key (#912).
 * 2. `identityKeyProbe.probeIdentityKeyPair` returns `'mismatch'` — and a
 *    mismatch is what authorises DELETING a surviving Keychain identity key
 *    (#913).
 *
 * Both degrade safely if a literal changes (to `'unknown'` and "throws"
 * respectively), but degrading safely means the feature silently stops
 * working. This test fails loudly instead, at the one moment it can be fixed
 * cheaply: an orbital_signal / libsignal bump.
 *
 * It reads the Rust source directly rather than a snapshot, because the Rust
 * source IS the contract and it lives in this repo.
 */

import * as fs from 'fs';
import * as path from 'path';

const ECIES_RS = path.join(
  __dirname,
  '../../../../packages/orbital-signal/rust/orbital_signal/src/ecies.rs',
);

/**
 * (SignalError variant, reason substring) pairs. The variant matters as much
 * as the reason: the classifier branches on the tag FIRST, so a literal that
 * moved to a different variant would break it while still being present.
 */
const PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  // consumer, variant, reason substring
  ['classifyEciesOpenError -> recipient_mismatch', 'InvalidMessage', 'decryption failed'],
  ['classifyEciesOpenError -> corrupt', 'InvalidMessage', 'DH produced identity point'],
  ['classifyEciesOpenError -> sender_mismatch', 'InvalidKey', 'does not match expected sender'],
  ['probeIdentityKeyPair -> mismatch', 'InvalidArgument', 'does not match'],
];

/** How many lines above the reason the `SignalError::Variant {` may sit. */
const VARIANT_WINDOW = 5;

describe('ecies.rs reason-string contract', () => {
  let lines: string[];

  beforeAll(() => {
    expect(fs.existsSync(ECIES_RS)).toBe(true);
    lines = fs.readFileSync(ECIES_RS, 'utf-8').split('\n');
  });

  it.each(PAIRS)(
    '%s: "%s" still carries a reason containing "%s"',
    (_consumer, variant, reason) => {
      const hits = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => line.includes('reason') && line.includes(reason));

      expect(hits.length).toBeGreaterThan(0);

      const pairedWithVariant = hits.some(({ i }) =>
        lines
          .slice(Math.max(0, i - VARIANT_WINDOW), i + 1)
          .some(l => l.includes(`SignalError::${variant}`)),
      );
      expect(pairedWithVariant).toBe(true);
    },
  );

  /**
   * The probe matches "does not match" as a SUBSTRING under one tag, so a
   * SECOND `InvalidArgument` reason containing it would also read as "this
   * private key does not belong to this public key" — and that answer is what
   * authorises deleting a surviving Keychain identity key (#913) and latching
   * the self-heal kill switch. Presence is not enough: uniqueness is the real
   * criterion, and it is one `format!` away from being lost.
   *
   * The InvalidKey "does not match expected sender" reason at the other end of
   * the file is deliberately not counted — a different tag, a different
   * decision (`sender_mismatch`, which is healed by a sender-key refresh).
   */
  it('carries exactly ONE InvalidArgument "does not match" reason — the deletion-authorising one', () => {
    const hits = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.includes('reason') && line.includes('does not match'));

    const underInvalidArgument = hits.filter(({ i }) =>
      lines
        .slice(Math.max(0, i - VARIANT_WINDOW), i + 1)
        .some(l => l.includes('SignalError::InvalidArgument')),
    );

    expect(underInvalidArgument).toHaveLength(1);
    expect(underInvalidArgument[0].line).toContain('sender_public_key does not match');
    // Non-vacuity: the other one still exists and is still the InvalidKey the
    // classifier reads as `sender_mismatch`, so this is a split of two reasons
    // and not a scan that found nothing.
    expect(hits.length).toBeGreaterThan(underInvalidArgument.length);
  });

  it('still returns InvalidSignature with no reason payload', () => {
    // classifyEciesOpenError maps a bare InvalidSignature to `corrupt` and must
    // not depend on an `inner` that does not exist.
    const bare = lines.some(l => /SignalError::InvalidSignature\s*\)?\s*;?\s*$/.test(l.trim()));
    expect(bare).toBe(true);
  });
});
