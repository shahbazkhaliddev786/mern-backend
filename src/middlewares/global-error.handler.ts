
import express from "express";

export default (err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.log("Request:: ", req);
    console.error(err.stack);
    res.status(500).json({ message: "Internal Server Error" });

    next();
}