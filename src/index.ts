import './tracing.js';
import config from './config/config.js';
import loaders from './loaders/index.js';
import { getPool } from './db/client.js';
import logger from './utils/logger.js';
import {createApp} from './app.js'

async function startServer() {
  const app = createApp();

  try {
    // The database must answer before the server takes requests (spec 023: Postgres).
    await getPool().query('SELECT 1');
    logger.info('DATABASE_CONNECTED', { meta: { DATABASE: new URL(config.DATABASE_URL).pathname.slice(1) } });

    // Initialize Express loaders (middleware, routes)
    await loaders({ app });

    // Start server
    app.listen(config.PORT, () => {
      logger.info('SERVER_STARTED', {
        meta: { PORT: config.PORT, SERVER_URL: config.SERVER_URL },
      });
    });

  } catch (err) {
    logger.error('APPLICATION_ERROR', { meta: err });
      process.exit(1);
  }
}

startServer();
