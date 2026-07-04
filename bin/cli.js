#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const tsxPath = join(projectRoot, "node_modules", ".bin", "tsx");

const args = process.argv.slice(2);
const command = args[0] === "stdio" || args[0] === "serve" ? args[0] : "serve";
const extraArgs = args[0] === "stdio" || args[0] === "serve" ? args.slice(1) : args;

const serverFile =
  command === "stdio" ? "src/server-stdio.ts" : "src/server.ts";
const serverPath = join(projectRoot, serverFile);

function runWithNode(tsx, path) {
  const child = spawn("node", [tsx, path, ...extraArgs], {
    stdio: "inherit",
    cwd: projectRoot,
    env: process.env,
  });

  child.on("error", (error) => {
    if (error.code === "ENOENT") {
      const npxChild = spawn("npx", ["-y", "tsx", path, ...extraArgs], {
        stdio: "inherit",
        cwd: projectRoot,
        env: process.env,
      });
      npxChild.on("error", (npxError) => {
        console.error("Failed to start server:", npxError);
        process.exit(1);
      });
      npxChild.on("exit", (code) => process.exit(code || 0));
    } else {
      console.error("Failed to start server:", error);
      process.exit(1);
    }
  });

  child.on("exit", (code) => process.exit(code || 0));
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`cursor-cloud-agent-mcp — MCP server for Cursor Cloud Agents API

Usage:
  cursor-cloud-agent-mcp [serve]     HTTP Streamable MCP (default, for Perplexity)
  cursor-cloud-agent-mcp stdio       stdio MCP (for Cursor / Claude Desktop)

Environment:
  CURSOR_API_KEY     Required — from cursor.com/settings
  MCP_AUTH_TOKEN     Recommended for HTTP — bearer token for /mcp
  PORT               HTTP port (default: 3000)
  TUNNEL=ngrok       Auto-start ngrok and print public HTTPS /mcp URL

Examples:
  export CURSOR_API_KEY=...
  export MCP_AUTH_TOKEN=...
  cursor-cloud-agent-mcp serve

  TUNNEL=ngrok cursor-cloud-agent-mcp serve
`);
  process.exit(0);
}

runWithNode(tsxPath, serverPath);
