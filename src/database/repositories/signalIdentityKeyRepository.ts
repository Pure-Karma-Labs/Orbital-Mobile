import type { SignalIdentityKeyRow, VerifiedStatus } from '../../types/database';
import { queryOne, queryMany, execute } from '../queryHelpers';

export function getIdentityKey(address: string): SignalIdentityKeyRow | null {
  return queryOne<SignalIdentityKeyRow>(
    'SELECT * FROM signal_identity_keys WHERE address = ?',
    [address],
  );
}

export function saveIdentityKey(row: SignalIdentityKeyRow): void {
  execute(
    `INSERT OR REPLACE INTO signal_identity_keys
       (address, identity_key, verified, first_use, nonblocking_approval)
     VALUES (?, ?, ?, ?, ?)`,
    [
      row.address,
      row.identity_key,
      row.verified,
      row.first_use,
      row.nonblocking_approval,
    ],
  );
}

export function removeIdentityKey(address: string): void {
  execute('DELETE FROM signal_identity_keys WHERE address = ?', [address]);
}

export function getAllIdentityKeys(): SignalIdentityKeyRow[] {
  return queryMany<SignalIdentityKeyRow>('SELECT * FROM signal_identity_keys');
}

/**
 * Update the verified status of a stored identity key.
 * Returns the number of rows affected (0 if no key exists for this address).
 */
export function updateIdentityKeyVerified(
  address: string,
  verified: VerifiedStatus,
): number {
  const result = execute(
    'UPDATE signal_identity_keys SET verified = ? WHERE address = ?',
    [verified, address],
  );
  return result.rowsAffected;
}
