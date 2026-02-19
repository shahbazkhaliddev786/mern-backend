import type { Response } from "express";

export type ApiResponse<T = unknown> = {
  status: "success" | "error";
  message: string;
  data?: T;
  meta?: Record<string, unknown>;
};


export const apiResponse = <T>(
  res: Response,
  statusCode: number,
  status: "success" | "error",
  message: string,
  data?: T,
  meta?: Record<string, unknown>
): void => {
  const body: ApiResponse<T> = {
    status,
    message,
  };

  if (data !== undefined) body.data = data;
  if (meta !== undefined) body.meta = meta;

  res.status(statusCode).json(body);
};