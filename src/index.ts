import config from "./config/config.js";
import loaders from "./loaders/index.js";
import {connectDB} from "./services/index.js";
import logger from "./utils/logger.js";
import { initRateLimiter } from "./config/rate.limiter.js";
import {createApp} from "./app.js"

async function startServer() {
  const app = createApp();

  try {
    // Connect to database
    const connection = await connectDB();
    logger.info("DATABASE_CONNECTED", { meta: { CONNECTION_NAME: connection.name } });

    // Initialize Express loaders (middleware, routes)
    await loaders({ app });

    // Start server
    app.listen(config.PORT, () => {
      logger.info("SERVER_STARTED", {
        meta: { PORT: config.PORT, SERVER_URL: config.SERVER_URL },
      });
    });

    // Initialize rate limiter
    initRateLimiter(connection);

  } catch (err) {
    logger.error("APPLICATION_ERROR", { meta: err });
      process.exit(1);
  }
}

startServer();
