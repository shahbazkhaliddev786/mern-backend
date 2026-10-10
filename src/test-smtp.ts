/* eslint-disable no-console -- a manual command-line diagnostic: printing is its job */
import config from './config/config.js';
import nodemailer from 'nodemailer';

// Mask a secret so it can be printed safely: show length + first/last char only.
const mask = (v: string | undefined) => {
  if (!v) return '(EMPTY / undefined)';
  if (v.length <= 4) return `${'*'.repeat(v.length)} (len=${v.length})`;
  return `${v[0]}***${v[v.length - 1]} (len=${v.length})`;
};

console.log('\n=== SMTP / Email config as seen by the app ===');
console.log('ENV        :', config.ENV);
console.log('SMTP_HOST  :', config.SMTP_HOST ?? '(undefined)');
console.log('SMTP_PORT  :', config.SMTP_PORT ?? '(undefined)');
console.log('SMTP_SECURE:', config.SMTP_SECURE ?? '(undefined)', '-> resolves to', config.SMTP_SECURE === 'true');
console.log('GMAIL      :', config.GMAIL || '(EMPTY)');
console.log('PASSWORD   :', mask(config.PASSWORD));

const transporter = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: Number(config.SMTP_PORT),
  secure: config.SMTP_SECURE === 'true',
  auth: {
    user: config.GMAIL,
    pass: config.PASSWORD,
  },
});

console.log('\n=== Verifying SMTP connection & credentials ===');
try {
  await transporter.verify();
  console.log('✅ SMTP verify() succeeded — host reachable and credentials accepted.');
} catch (err: any) {
  console.log('❌ SMTP verify() FAILED');
  console.log('   name   :', err?.name);
  console.log('   code   :', err?.code);
  console.log('   command:', err?.command);
  console.log('   message:', err?.message);
}

process.exit(0);
