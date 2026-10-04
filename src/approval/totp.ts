import { config } from 'dotenv';
import * as OTPAuth from 'otpauth';

// Written by `npm run approval:setup`
config({ path: ['.env.approval'], quiet: true });

const LOCKOUT_AFTER_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export function createTotp(secret: OTPAuth.Secret): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: 'OmniStore DB MCP',
    label: 'migration approval',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });
}

let totp: OTPAuth.TOTP | undefined;
// Each time step can approve at most once, so a code someone watched being typed can't be reused.
let lastAcceptedStep = -1;
// Counted across all plans, because a caller can create new plans without limit.
let consecutiveFailures = 0;
let lockedUntil = 0;

export function isTotpConfigured(): boolean {
  return Boolean(process.env.APPROVAL_TOTP_SECRET);
}

export type CodeCheck = { ok: true } | { ok: false; reason: 'invalid' | 'locked'; lockedUntil?: number };

export function checkCode(code: string): CodeCheck {
  if (!isTotpConfigured()) throw new Error('No TOTP secret. Run `npm run approval:setup`.');
  totp ??= createTotp(OTPAuth.Secret.fromBase32(process.env.APPROVAL_TOTP_SECRET!));

  if (Date.now() < lockedUntil) return { ok: false, reason: 'locked', lockedUntil };

  const delta = /^\d{6}$/.test(code) ? totp.validate({ token: code, window: 1 }) : null;
  const step = delta === null ? null : totp.counter() + delta;
  if (step !== null && step > lastAcceptedStep) {
    lastAcceptedStep = step;
    consecutiveFailures = 0;
    return { ok: true };
  }

  consecutiveFailures++;
  if (consecutiveFailures >= LOCKOUT_AFTER_FAILURES) {
    consecutiveFailures = 0;
    lockedUntil = Date.now() + LOCKOUT_MS;
    return { ok: false, reason: 'locked', lockedUntil };
  }
  return { ok: false, reason: 'invalid' };
}
