
import express from 'express';
import logger from '../utils/logger.js';

export default (err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled request error', { method: req.method, path: req.path, error: err.message, stack: err.stack });
    res.status(500).json({ 
        status: 'error',
        message: err.message || 'Internal Server Error' 
    });
}