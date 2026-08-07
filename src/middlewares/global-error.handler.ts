
import express from "express";

export default (err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
    console.error(err.stack);
    res.status(500).json({ 
        status: "error",
        message: err.message || "Internal Server Error" 
    });
}