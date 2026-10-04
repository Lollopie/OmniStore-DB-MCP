// Creates the authenticator secret for migration approvals and stores it in .env.approval.
// Run once with `npm run approval:setup`; add --force to replace an existing secret.
import { existsSync, writeFileSync } from 'fs';
import { createInterface } from 'readline/promises';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { createTotp } from '../src/approval/totp';

const FILE = '.env.approval';

async function main() {
  if (existsSync(FILE) && !process.argv.includes('--force')) {
    throw new Error(`${FILE} already exists. Run with --force to replace it; the old authenticator entry stops working.`);
  }
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = createTotp(secret);
  const uri = totp.toString();

  console.log('Scan this with your authenticator app (Google Authenticator, Aegis, 1Password, ...):\n');
  console.log(await QRCode.toString(uri, { type: 'terminal', small: true }));
  console.log(`Or enter this key manually: ${secret.base32}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const code = (await rl.question('Enter the 6-digit code the app shows now: ')).trim();
      if (totp.validate({ token: code, window: 1 }) !== null) {
        writeFileSync(FILE, `# Written by \`npm run approval:setup\`. TOTP secret for approving migrations; keep it secret.\nAPPROVAL_TOTP_SECRET=${secret.base32}\n`);
        console.log(`Saved to ${FILE}. Restart the MCP server to load it.`);
        return;
      }
      console.log('That code doesn\'t match. Check that the phone\'s clock is correct.');
    }
    throw new Error('No valid code entered. Nothing was saved; run the setup again.');
  } finally {
    rl.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
