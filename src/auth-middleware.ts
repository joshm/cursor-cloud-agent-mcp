import type { Request, Response, NextFunction } from "express";

/**
 * Optional bearer auth for /mcp. When MCP_AUTH_TOKEN is set, clients must send:
 *   Authorization: Bearer <token>
 * Perplexity remote connectors pass this via the authorization field.
 */
export function mcpAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const expected = process.env.MCP_AUTH_TOKEN?.trim();
  if (!expected) {
    next();
    return;
  }

  const header = req.headers.authorization;
  if (!header) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing Authorization header" },
      id: null,
    });
    return;
  }

  const token = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : header.trim();

  if (token !== expected) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: invalid token" },
      id: null,
    });
    return;
  }

  next();
}
