import { spawn, type ChildProcess } from "node:child_process";

interface NgrokTunnel {
  public_url?: string;
}

interface NgrokApiResponse {
  tunnels?: NgrokTunnel[];
}

/** Start ngrok in the background and return the public HTTPS URL for /mcp. */
export async function startNgrokTunnel(port: number): Promise<{
  publicUrl: string;
  child: ChildProcess;
}> {
  const child = spawn("ngrok", ["http", String(port), "--log=stdout"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const spawnError = await new Promise<Error | null>((resolve) => {
    child.once("error", (err) => resolve(err));
    child.once("spawn", () => resolve(null));
  });

  if (spawnError) {
    if ((spawnError as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "ngrok is not installed. Install it with: brew install ngrok\n" +
          "Then authenticate: ngrok config add-authtoken <token>  (free at https://ngrok.com)\n" +
          "Or run without a tunnel: npm run serve"
      );
    }
    throw spawnError;
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const res = await fetch("http://127.0.0.1:4040/api/tunnels");
      if (!res.ok) continue;
      const data = (await res.json()) as NgrokApiResponse;
      const https = data.tunnels?.find((t) => t.public_url?.startsWith("https://"));
      if (https?.public_url) {
        return { publicUrl: `${https.public_url}/mcp`, child };
      }
    } catch {
      // ngrok API not ready yet
    }
  }

  child.kill();
  throw new Error(
    "ngrok started but no HTTPS tunnel URL was found within 15s. Is ngrok installed and authenticated?"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
