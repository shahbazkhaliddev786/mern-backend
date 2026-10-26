// `npm run agent:review` (spec 021): the owner's review queue of flagged live turns (judge flags
// and thumbs-down), newest first, with their redacted snapshots. Run locally against production
// (DATABASE_URL or ONLINE_EVALS_DATABASE_URL). A problem worth keeping becomes a hand-written
// golden in evals/agent/goldens.json with the test catalog and customers, never customer text.
//   npm run agent:review
//   npm run agent:review -- --resolve s:<id> --as promoted|dismissed [--note "…"]

import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import config from '../../src/config/config.js';
import { listFlagged, renderFlagged, resolveFlagged } from './online';

const print = (text: string) => process.stdout.write(`${text}\n`);

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { resolve: { type: 'string' }, as: { type: 'string' }, note: { type: 'string' } } });
  const url = process.env.ONLINE_EVALS_DATABASE_URL || config.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL (or ONLINE_EVALS_DATABASE_URL)');
  await mongoose.connect(url);
  if (values.resolve) {
    if (values.as !== 'promoted' && values.as !== 'dismissed') throw new Error('--as must be promoted or dismissed');
    const done = await resolveFlagged(values.resolve, values.as, values.note);
    print(done ? `${values.resolve}: ${values.as}` : `${values.resolve}: not found`);
    return done ? 0 : 1;
  }
  print(renderFlagged(await listFlagged()));
  return 0;
}

// Exit explicitly: the app logger's MongoDB transport keeps its own connection open.
main()
  .catch((error: unknown) => {
    process.stderr.write(`Review failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  })
  .then(async (code) => {
    await mongoose.disconnect();
    process.exit(code);
  });
