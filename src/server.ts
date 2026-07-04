import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { createMcpServer } from "./backend.js";
import { mcpAuthMiddleware } from "./auth-middleware.js";
import { startNgrokTunnel } from "./tunnel.js";

const SERVER_VERSION = "1.1.0";
const port = parseInt(process.env.PORT || "3000", 10);

const app = express();
app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  next();
});
app.options("/mcp", (_req, res) => res.sendStatus(204));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "cursor-cloud-agent-mcp",
    version: SERVER_VERSION,
    auth: Boolean(process.env.MCP_AUTH_TOKEN?.trim()),
  });
});

const transports: Record<string, StreamableHTTPServerTransport> = {};

function createServerForSession(): McpServer {
  return createMcpServer();
}

app.post("/mcp", mcpAuthMiddleware, async (req, res) => {
  try {
    const body = req.body;
    if (body?.method === "tools/call") {
      console.log("[mcp] tools/call:", body.params?.name, JSON.stringify(body.params?.arguments ?? {}));
    } else if (body?.method) {
      console.log("[mcp]", body.method, body.id ?? "");
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          transports[id] = transport;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
        }
      };

      const server = createServerForSession();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const handleSessionRequest = async (
  req: express.Request,
  res: express.Response
) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
};

app.get("/mcp", mcpAuthMiddleware, handleSessionRequest);
app.delete("/mcp", mcpAuthMiddleware, handleSessionRequest);

let ngrokChild: ChildProcess | undefined;

const httpServer = app.listen(port, async () => {
  console.log(`MCP StreamableHTTP server listening on port ${port}`);
  console.log(`Local endpoint: http://localhost:${port}/mcp`);

  if (!process.env.MCP_AUTH_TOKEN?.trim()) {
    console.warn(
      "Warning: MCP_AUTH_TOKEN is not set. /mcp is open to anyone who can reach this host."
    );
  }

  if (process.env.TUNNEL === "ngrok") {
    try {
      const { publicUrl, child } = await startNgrokTunnel(port);
      ngrokChild = child;
      console.log(`Public endpoint (Perplexity): ${publicUrl}`);
      if (process.env.MCP_AUTH_TOKEN?.trim()) {
        console.log("Set Perplexity connector authorization to your MCP_AUTH_TOKEN.");
      }
    } catch (err) {
      console.error("Failed to start ngrok tunnel:", err);
    }
  }
});

async function shutdown() {
  for (const sid of Object.keys(transports)) {
    try {
      await transports[sid].close();
    } catch {
      // ignore
    }
    delete transports[sid];
  }
  ngrokChild?.kill();
  httpServer.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
