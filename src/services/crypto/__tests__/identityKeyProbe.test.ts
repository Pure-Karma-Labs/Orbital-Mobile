/**
 * Tests for identityKeyProbe — the seal+open identity-key round trip (#913).
 *
 * The behaviour under test is the ERROR TAXONOMY, not the crypto: 'mismatch'
 * is the one answer that authorises deleting a surviving Keychain key or
 * latching the self-heal kill switch, so every ambiguous failure must escape
 * as a throw.
 */

jest.mock('orbital-signal', () => ({
  eciesSeal: jest.fn(),
  eciesOpen: jest.fn(),
  SignalError_Tags: {
    InvalidKey: 'InvalidKey',
    InvalidMessage: 'InvalidMessage',
    InvalidSignature: 'InvalidSignature',
    InvalidArgument: 'InvalidArgument',
    InternalError: 'InternalError',
  },
}));

import { eciesSeal, eciesOpen } from 'orbital-signal';
import { probeIdentityKeyPair } from '../identityKeyProbe';

const PRIV = new ArrayBuffer(32);
const PUB = new ArrayBuffer(33);

/** The real seal-side mismatch error, as uniffi lifts it. */
function sealMismatchError(): unknown {
  const err = new Error('SignalError.InvalidArgument');
  Object.assign(err, {
    tag: 'InvalidArgument',
    inner: {
      reason: 'ecies_seal: sender_public_key does not match sender_private_key',
    },
  });
  return err;
}

function signalError(tag: string, reason?: string): unknown {
  const err = new Error(`SignalError.${tag}`);
  Object.assign(err, reason === undefined ? { tag } : { tag, inner: { reason } });
  return err;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('probeIdentityKeyPair — match', () => {
  it("returns 'match' when seal and open both succeed", () => {
    (eciesSeal as jest.Mock).mockReturnValue(new ArrayBuffer(190));
    (eciesOpen as jest.Mock).mockReturnValue(new ArrayBuffer(32));

    expect(probeIdentityKeyPair(PRIV, PUB)).toBe('match');
    expect(eciesSeal).toHaveBeenCalledTimes(1);
    expect(eciesOpen).toHaveBeenCalledTimes(1);
  });

  it('seals a fresh 32-byte plaintext and uses the same context for both calls', () => {
    (eciesSeal as jest.Mock).mockReturnValue(new ArrayBuffer(190));
    (eciesOpen as jest.Mock).mockReturnValue(new ArrayBuffer(32));

    probeIdentityKeyPair(PRIV, PUB);

    const sealArgs = (eciesSeal as jest.Mock).mock.calls[0];
    const openArgs = (eciesOpen as jest.Mock).mock.calls[0];
    // [plaintext, context, recipientPub, senderPriv, senderPub]
    expect((sealArgs[0] as ArrayBuffer).byteLength).toBe(32);
    // Seal to self: recipient and sender-public are both our public key.
    expect(sealArgs[2]).toBe(PUB);
    expect(sealArgs[3]).toBe(PRIV);
    expect(sealArgs[4]).toBe(PUB);
    // A context mismatch would false-negative and discard a valid key.
    expect(new Uint8Array(openArgs[1] as ArrayBuffer)).toEqual(
      new Uint8Array(sealArgs[1] as ArrayBuffer),
    );
    expect(openArgs[2]).toBe(PRIV);
    expect(openArgs[3]).toBe(PUB);
  });

  it('uses a different plaintext on each call', () => {
    (eciesSeal as jest.Mock).mockReturnValue(new ArrayBuffer(190));
    (eciesOpen as jest.Mock).mockReturnValue(new ArrayBuffer(32));

    probeIdentityKeyPair(PRIV, PUB);
    probeIdentityKeyPair(PRIV, PUB);

    const first = new Uint8Array((eciesSeal as jest.Mock).mock.calls[0][0]);
    const second = new Uint8Array((eciesSeal as jest.Mock).mock.calls[1][0]);
    expect(Array.from(second)).not.toEqual(Array.from(first));
  });
});

describe('probeIdentityKeyPair — mismatch comes from SEAL (#913)', () => {
  it("returns 'mismatch' on the seal InvalidArgument 'does not match' error", () => {
    (eciesSeal as jest.Mock).mockImplementation(() => {
      throw sealMismatchError();
    });

    expect(probeIdentityKeyPair(PRIV, PUB)).toBe('mismatch');
  });

  it('never reaches eciesOpen on a seal mismatch', () => {
    (eciesSeal as jest.Mock).mockImplementation(() => {
      throw sealMismatchError();
    });

    probeIdentityKeyPair(PRIV, PUB);

    expect(eciesOpen).not.toHaveBeenCalled();
  });
});

describe('probeIdentityKeyPair — everything else is rethrown', () => {
  it('rethrows InvalidArgument whose reason lacks the mismatch fragment', () => {
    const err = signalError('InvalidArgument', 'ecies_seal: plaintext must not be empty');
    (eciesSeal as jest.Mock).mockImplementation(() => {
      throw err;
    });

    expect(() => probeIdentityKeyPair(PRIV, PUB)).toThrow(err as Error);
  });

  it('rethrows a non-InvalidArgument tag even when the reason says "does not match"', () => {
    const err = signalError(
      'InvalidKey',
      'ecies_open: sender public key does not match expected sender',
    );
    (eciesSeal as jest.Mock).mockReturnValue(new ArrayBuffer(190));
    (eciesOpen as jest.Mock).mockImplementation(() => {
      throw err;
    });

    expect(() => probeIdentityKeyPair(PRIV, PUB)).toThrow(err as Error);
  });

  it('rethrows an InvalidArgument raised by eciesOpen without the fragment', () => {
    const err = signalError('InvalidArgument', 'ecies_open: context too long');
    (eciesSeal as jest.Mock).mockReturnValue(new ArrayBuffer(190));
    (eciesOpen as jest.Mock).mockImplementation(() => {
      throw err;
    });

    expect(() => probeIdentityKeyPair(PRIV, PUB)).toThrow(err as Error);
  });

  it('rethrows InvalidMessage "decryption failed"', () => {
    const err = signalError('InvalidMessage', 'ecies_open: decryption failed');
    (eciesSeal as jest.Mock).mockReturnValue(new ArrayBuffer(190));
    (eciesOpen as jest.Mock).mockImplementation(() => {
      throw err;
    });

    expect(() => probeIdentityKeyPair(PRIV, PUB)).toThrow(err as Error);
  });

  it('rethrows a tagged error that carries no inner (InvalidSignature shape)', () => {
    const err = signalError('InvalidSignature');
    (eciesSeal as jest.Mock).mockImplementation(() => {
      throw err;
    });

    expect(() => probeIdentityKeyPair(PRIV, PUB)).toThrow(err as Error);
  });

  it('rethrows a duck-typed object carrying only the tag and the reason', () => {
    // The discriminator is the uniffi message shape, not the properties: an
    // object shaped like a SignalError is not one, and 'mismatch' is the single
    // answer that authorises deleting a surviving Keychain identity key.
    const impostor = {
      tag: 'InvalidArgument',
      inner: { reason: 'ecies_seal: sender_public_key does not match sender_private_key' },
    };
    (eciesSeal as jest.Mock).mockImplementation(() => {
      throw impostor;
    });

    let thrown: unknown;
    try {
      probeIdentityKeyPair(PRIV, PUB);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(impostor);
  });

  it('rethrows a tagged Error whose message is not SignalError.<Variant>', () => {
    const err = Object.assign(new Error('something failed'), {
      tag: 'InvalidArgument',
      inner: { reason: 'ecies_seal: sender_public_key does not match sender_private_key' },
    });
    (eciesSeal as jest.Mock).mockImplementation(() => {
      throw err;
    });

    expect(() => probeIdentityKeyPair(PRIV, PUB)).toThrow(err);
  });

  it('rethrows a plain Error with no tag', () => {
    const err = new Error('native module unavailable');
    (eciesSeal as jest.Mock).mockImplementation(() => {
      throw err;
    });

    expect(() => probeIdentityKeyPair(PRIV, PUB)).toThrow(err);
  });

  it('rethrows a non-object throw', () => {
    (eciesSeal as jest.Mock).mockImplementation(() => {
      throw 'boom';
    });

    expect(() => probeIdentityKeyPair(PRIV, PUB)).toThrow('boom');
  });
});
