import config from "./config/config.js";
import loaders from "./loaders/index.js";
import {connectDB} from "./services/index.js";
import logger from "./utils/logger.js";
import { initRateLimiter } from "./config/rate.limiter.js";
import {createApp} from "./app.js"

// Must push changes:
// TODO: implement filtering on getProducts endpoint
// TODO: Implement security best practices
// TODO: Add API documentation using Swagger
// TODO: Rate limiting and request throttling, rate limiting algorithms
// TODO: Write types in types folder
// TODO: Maintain proper github repo with branches and PRs, tanay pratap 

// TODO: Find some api optimization techniques
// TODO: use dependency injection for better testability
// TODO: add unit, integration tests and e2e tests. use jest and supertest. 
//       prettier for code formatting, husky for pre-commit hooks, lint-staged 
//       for linting staged files, commitlint for commit message conventions
//       code coverage should be above 80%. etc.
// TODO: Remove console.log statements and use logger instead, remove unused code
// TODO: Dockerize the application for consistent deployment
// TODO: setup CI/CD pipeline for automated testing and deployment

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
