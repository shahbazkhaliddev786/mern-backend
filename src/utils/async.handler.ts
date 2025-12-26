import type { Request, Response, NextFunction, RequestHandler } from 'express';

/* Parameters of generic:
    1st → req.params
    2nd → response body
    3rd → req.body
    4th → req.query
*/

export const asyncHandler = <
  P = Record<string, string>,
  ResBody = any,
  ReqBody = any,
  ReqQuery = Record<string, string>
>(
  fn: (req: Request<P, ResBody, ReqBody, ReqQuery>, res: Response<ResBody>, next: NextFunction) => Promise<any>
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    // Cast req/res to any to bridge the generic gap — safe because we control the types
    Promise.resolve(fn(req as any, res as any, next)).catch(next);
  };
};