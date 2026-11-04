import express from 'express';
import { clientErrorMessage, describeError, isDbError } from '../db/client.js';
import logger from '../utils/logger.js';

export default (err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // A database error's message and stack carry its SQL and values, so only its description is logged.
    logger.error('Unhandled request error', { method: req.method, path: req.path, error: describeError(err), ...(isDbError(err) ? {} : { stack: err.stack }) });
    res.status(500).json({ 
        status: 'error',
        message: clientErrorMessage(err, 'Internal Server Error')
    });
}
