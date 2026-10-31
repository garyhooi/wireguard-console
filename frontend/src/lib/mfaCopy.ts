/**
 * Centralized copy for the MFA sign-in challenge and forced-enrollment flow.
 *
 * Every user-facing string on /mfa-verify and /mfa-setup (and the pending
 * redirects on /login) lives here so wording stays consistent across the
 * pages and tests, and so the WebAuthn error table has exactly one home.
 *
 * This module also owns navigateTo(), the single redirect indirection used by
 * the pre-session pages. jsdom cannot intercept window.location assignment,
 * so routing every hard navigation through this one function lets tests spy
 * on it instead of relying on real browser navigation.
 */

/** Hard navigation (full page load) used at session boundaries. */
export function navigateTo(path: string): void {
  if (typeof window === 'undefined') return
  window.location.href = path
}

/** Product copy: title / body / button strings for the two screens. */
export const mfaCopy = {
  common: {
    signInAgain: 'Sign in again',
    signOutAndRestart: 'Sign in with a different account',
    back: 'Back',
    cancel: 'Cancel',
    continue: 'Continue',
    tryAgain: 'Try again',
    or: 'or',
  },

  verify: {
    loading: 'Checking this sign-in…',
    title: 'Verify it is you',
    subtitle: 'Confirm with your passkey, or use an authenticator code.',
    subtitleRecovery: 'Enter one of the recovery codes you saved when you set up multi-factor authentication.',
    passkeyButton: 'Use a passkey',
    passkeyBusy: 'Waiting for your passkey…',
    passkeyDivider: 'or use an authenticator code',
    passkeyUnsupported:
      'This browser cannot use passkeys. Use your authenticator app or a recovery code instead.',
    passkeyBlocked:
      'This browser cannot use passkeys and this account has no other usable sign-in method. Try another browser or device, or ask a super admin to reset your MFA.',
    passkeyHint: 'Passkeys are available for this account.',
    totpLabel: 'Authenticator code',
    totpPlaceholder: '000000',
    totpHelp: 'Open your authenticator app and enter the current 6-digit code.',
    verifyButton: 'Verify',
    verifyingButton: 'Verifying…',
    useRecovery: 'Use a recovery code',
    useOtherMethods: 'Back to sign-in options',
    recoveryLabel: 'Recovery code',
    recoveryPlaceholder: 'XXXX-XXXX-XXXX',
    recoveryHelp: 'Each recovery code works once. Dashes and capitalisation do not matter.',
    recoverySubmit: 'Verify recovery code',
    noMethods:
      'This account has no usable sign-in method in this browser. Try another browser or device, or ask a super admin to reset your MFA.',
    expiredTitle: 'This sign-in expired for security',
    expiredBody:
      'For your safety the sign-in attempt timed out. Start again from the sign-in page.',
    disabledTitle: 'Account disabled',
    disabledBody: 'This account has been disabled. Contact your administrator.',
    invalidCode: 'That code is not valid. Check your authenticator app and try again.',
    invalidRecoveryCode: 'That recovery code is not valid. Check the code and try again.',
    passkeyCancelled:
      'The passkey prompt was dismissed or timed out. Try again, or use your authenticator code.',
    passkeyFailed: 'That passkey could not be verified. Try again or use another method.',
    rateLimited: 'Too many verification attempts. Try again later.',
    footerHelp: 'Trouble signing in? Ask a super admin to reset your MFA.',
  },

  setup: {
    loading: 'Checking your account…',
    title: 'Set up multi-factor authentication',
    forcedIntro:
      'Multi-factor authentication is required for every admin before the console can be used. Set up at least one method now — you will confirm with it on every future sign-in.',
    chooseTitle: 'Choose your methods',
    chooseSubtitle:
      'You can add both. A passkey is the fastest and most phishing-resistant option; an authenticator app works with any phone.',
    chooseHint: 'Choose at least one method to continue.',
    passkeyCardTitle: 'Passkey',
    passkeyCardBadge: 'Recommended',
    passkeyCardBody:
      'Face ID, Touch ID, Windows Hello or a security key. Fast, phishing-resistant, and nothing to type.',
    passkeyRecommendedButton: 'Use a passkey',
    totpCardTitle: 'Authenticator app',
    totpCardBody:
      'Scan a QR code with Google Authenticator, Authy, 1Password, or any TOTP app.',
    totpCardButton: 'Use an authenticator app',
    requiredByPolicy: 'Required by your organisation',
    requiredBoth: 'Your console requires both a passkey and an authenticator app.',
    requiredTotp: 'Your console requires an authenticator app.',
    requiredPasskey: 'Your console requires a passkey.',
    passkeyUnavailable: 'Passkeys are not available on this deployment.',
    passkeyUnsupported: 'Passkeys need HTTPS on a domain name and a modern browser. You can set up an authenticator app instead.',
    continueButton: 'Continue',
    totpTitle: 'Set up your authenticator app',
    totpSubtitle: 'Scan this QR code with your authenticator app, or enter the key manually.',
    totpManualKey: 'Or enter this key manually',
    totpCodeLabel: 'Enter the 6-digit code',
    totpVerifyButton: 'Verify and add authenticator app',
    totpVerifyingButton: 'Verifying…',
    totpInvalid: 'That code is not valid. Check your authenticator app and try again.',
    totpAlreadyEnabled: 'An authenticator app is already set up for this account.',
    totpAdded: 'Authenticator app added.',
    passkeyTitle: 'Create a passkey',
    passkeySubtitle:
      'Your browser will ask for Face ID, Touch ID, Windows Hello, or your security key. The passkey stays on your device — the console only stores its public key.',
    passkeyCreateButton: 'Create passkey',
    passkeyCreatingButton: 'Waiting for your passkey…',
    passkeyAdded: 'Passkey added.',
    passkeyAnother: 'Add another passkey',
    passkeyFailed: 'The passkey could not be created. Try again, or use an authenticator app.',
    passkeyCancelled:
      'The passkey prompt was dismissed or timed out. Try again, or use an authenticator app.',
    passkeyNotSupportedThisBrowser:
      'This browser cannot create passkeys. Set up an authenticator app instead.',
    reviewTitle: 'Review your methods',
    reviewSubtitle: 'These factors will protect your account from now on.',
    reviewTotp: 'Authenticator app',
    reviewPasskey: 'Passkey',
    reviewAdded: 'Added',
    reviewMissing: 'Not added yet',
    completeButton: 'Complete setup',
    completingButton: 'Finishing…',
    recoveryTitle: 'Save your recovery codes',
    recoverySubtitle:
      'These codes are shown only once. Each can be used one time to sign in if you lose access to your passkey or authenticator app. Keep them somewhere safe and offline.',
    recoveryCopyAll: 'Copy all',
    recoveryCopied: 'Copied',
    recoveryDownload: 'Download as .txt',
    recoveryAck: 'I have saved these recovery codes',
    recoveryContinue: 'Continue to dashboard',
    recoveryMissing:
      'Your account was set up, but no new recovery codes were issued because you already have some.',
    doneTitle: 'MFA is on',
    doneSubtitle: 'Your account is protected. You will confirm with a factor on every sign-in.',
    expiredTitle: 'Enrollment session expired',
    expiredBody: 'For your safety the pending enrollment timed out. Sign in again to continue.',
    policyViolation: 'Your console policy requires more methods. Add the missing method to continue.',
    missingMethodsLabel: 'Still required:',
    authedTitle: 'Multi-factor authentication is managed from your profile',
    authedSubtitle:
      'Add passkeys, change your authenticator app, or regenerate recovery codes from Profile → Multi-factor authentication.',
    authedGoToProfile: 'Go to Profile',
    needsSignInTitle: 'Sign-in required',
    needsSignInBody: 'There is no pending enrollment to finish. Sign in to continue.',
    alreadyEnabledTitle: 'Already set up',
    alreadyEnabledBody: 'Multi-factor authentication is already enabled for this account.',
  },

  webauthnErrors: {
    unsupported:
      'Passkeys need HTTPS on a domain name and a modern browser. Use your authenticator app or a recovery code instead.',
    insecure_context:
      'Passkeys require HTTPS on a domain name (not an IP address). Use your authenticator app or a recovery code instead.',
    cancelled_or_timeout:
      'The passkey prompt was dismissed or timed out. Try again, or use your authenticator code.',
    ceremony_aborted: '',
    rp_id_mismatch:
      'Passkeys are configured for a different address (RP ID mismatch). Contact your administrator.',
    invalid_domain: 'Passkeys are not available on this address. Contact your administrator.',
    already_registered:
      'This authenticator already has a passkey for this account. Try another device, or use your authenticator app.',
    unsupported_algorithm:
      'This authenticator does not support the required passkey algorithm. Try another authenticator.',
    malformed_options:
      'Passkeys are not available right now. Try again later or use your authenticator app.',
    missing_user_verification:
      'This authenticator cannot verify you with a PIN or biometric. Try another authenticator.',
    missing_discoverable_credential:
      'This authenticator cannot store a passkey. Try another device.',
    general_error: 'The authenticator could not complete the request. Try again.',
    invalid_user_id: 'Passkeys are not available right now. Contact your administrator.',
  },

  serverErrors: {
    mfa_no_pending: 'This sign-in has expired. Start again from the sign-in page.',
    mfa_invalid: 'That code is not valid. Try again.',
    mfa_locked: 'Too many attempts. Try again later.',
    mfa_last_factor: 'This is your only sign-in method, so it cannot be removed.',
    mfa_no_factor: 'Set up at least one sign-in method first.',
    mfa_already_enabled: 'That method is already set up.',
    mfa_passkey_failed: 'That passkey could not be verified. Try again or use another method.',
    mfa_no_passkeys: 'This account has no passkeys registered.',
    mfa_unavailable: 'Passkeys are not available on this deployment.',
    mfa_policy_violation: 'Your console policy requires more sign-in methods.',
    mfa_required: 'Multi-factor authentication is required before continuing.',
    csrf_failed: 'Your session token expired. Reload the page and try again.',
  },
} as const

/** Human copy for a server `code` field, if we recognise it. */
export function mfaServerErrorCopy(code: string | undefined): string | undefined {
  if (!code) return undefined
  const map = mfaCopy.serverErrors as Record<string, string>
  return map[code]
}
