/**
 * Transient in-memory recovery-initiator flag.
 *
 * Extracted from keyRecoveryService into its own dependency-free module to
 * avoid an import cycle: notificationService (#539's identity_key_reset push
 * handler) needs to read this flag, but keyRecoveryService imports authService
 * (for loginForRecovery), and authService imports notificationService (for
 * deregisterCurrentDevice on logout). A direct notificationService ->
 * keyRecoveryService import would close that cycle.
 *
 * keyRecoveryService re-exports `isRecoveryInitiator` for backward
 * compatibility with existing callers/tests.
 */

let _isRecoveryInitiator = false;

/** True while THIS device is executing a recovery flow. #539 uses this to
 *  suppress the identity_key_reset push handler on the initiating device. */
export function isRecoveryInitiator(): boolean {
  return _isRecoveryInitiator;
}

/** Set by keyRecoveryService at the start/end of recoverIdentityKeys. */
export function setRecoveryInitiator(value: boolean): void {
  _isRecoveryInitiator = value;
}
