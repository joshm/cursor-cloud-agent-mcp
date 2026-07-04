import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v3";
import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { resolve } from "path";

const execAsync = promisify(exec);

/** LLM clients (e.g. Perplexity) often send "true"/"false" strings for booleans. */
const looseBoolean = z
  .union([z.boolean(), z.string(), z.number()])
  .optional()
  .transform((val) => {
    if (val === undefined) return undefined;
    if (typeof val === "boolean") return val;
    if (typeof val === "number") return val !== 0;
    const s = String(val).toLowerCase().trim();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
    return Boolean(val);
  });

/** LLM clients often send numbers as strings (e.g. "45"). */
const looseNumber = (opts: { min?: number; max?: number; default?: number }) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === null || val === "") {
        return opts.default;
      }
      const n = typeof val === "number" ? val : Number(String(val).trim());
      if (!Number.isFinite(n)) {
        return opts.default;
      }
      let out = Math.round(n);
      if (opts.min !== undefined) out = Math.max(opts.min, out);
      if (opts.max !== undefined) out = Math.min(opts.max, out);
      return out;
    });

/** LLM clients may send arrays as JSON strings or a single value. */
const looseStringArray = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((val) => {
    if (val === undefined || val === null || val === "") return undefined;
    if (Array.isArray(val)) return val.map(String);
    const s = String(val).trim();
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        // fall through
      }
    }
    return [s];
  });

const API_BASE_URL = "https://api.cursor.com";
const REQUEST_TIMEOUT_MS = 30000;

type CreateTaskResult = {
  id: string;
  name: string;
  status: string;
  source: { repository: string; ref?: string };
  target: {
    branchName?: string;
    url?: string;
    prUrl?: string;
    autoCreatePr?: boolean;
    openAsCursorGithubApp?: boolean;
    skipReviewerRequest?: boolean;
  };
  createdAt: string;
};

type PendingCreate = {
  status: "pending" | "done" | "error";
  startedAt: string;
  args: Record<string, unknown>;
  result?: CreateTaskResult;
  error?: string;
};

const pendingCreates = new Map<string, PendingCreate>();

function buildCreateTaskBody(args: {
  prompt: string;
  repository: string;
  ref?: string;
  auto_pr?: boolean;
  branch_name?: string;
  model?: string;
  plan_file?: string;
  planContent?: string;
}): Record<string, unknown> {
  let promptText = args.prompt;
  if (args.planContent) {
    promptText = `${args.prompt}\n\n## Plan File\n\n${args.planContent}`;
  }

  const requestBody: Record<string, unknown> = {
    prompt: { text: promptText },
    source: { repository: args.repository },
  };

  if (args.ref) {
    (requestBody.source as Record<string, unknown>).ref = args.ref;
  }

  if (args.auto_pr !== undefined || args.branch_name) {
    requestBody.target = {
      autoCreatePr: args.auto_pr,
      branchName: args.branch_name,
    };
  }

  if (args.model) {
    requestBody.model = args.model;
  }

  return requestBody;
}

async function executeCreateTask(
  requestBody: Record<string, unknown>
): Promise<CreateTaskResult> {
  return apiRequest<CreateTaskResult>("POST", "/v0/agents", requestBody);
}

function startCreateTaskAsync(
  pendingId: string,
  args: Record<string, unknown>,
  requestBody: Record<string, unknown>
): void {
  pendingCreates.set(pendingId, {
    status: "pending",
    startedAt: new Date().toISOString(),
    args,
  });

  void executeCreateTask(requestBody)
    .then((result) => {
      pendingCreates.set(pendingId, {
        status: "done",
        startedAt: pendingCreates.get(pendingId)!.startedAt,
        args,
        result,
      });
      console.log("[create_task] done:", result.id, result.target?.url ?? "");
    })
    .catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      pendingCreates.set(pendingId, {
        status: "error",
        startedAt: pendingCreates.get(pendingId)!.startedAt,
        args,
        error: errorMessage,
      });
      console.error("[create_task] failed:", errorMessage);
    });
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  console.error("Error: CURSOR_API_KEY environment variable is required");
  console.error("Get your API key from https://cursor.com/settings");
  process.exit(1);
}

// ============================================================================
// API CLIENT
// ============================================================================

async function apiRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  const authHeader = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const options: RequestInit = {
      method,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorText: string;
      try {
        errorText = await response.text();
      } catch {
        errorText = "Unable to read error response";
      }
      throw new Error(`API error ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<T>;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// Helper function to check if text matches a regex pattern
function matchesRegex(text: string, pattern: string): boolean {
  try {
    const regex = new RegExp(pattern, "i"); // case-insensitive
    return regex.test(text);
  } catch (error) {
    // Invalid regex pattern - log error but don't throw
    console.error(`Invalid regex pattern: ${pattern}`, error);
    return false;
  }
}

const TERMINAL_TASK_STATUSES = new Set([
  "FINISHED",
  "FAILED",
  "CANCELLED",
]);

type ConversationMessage = {
  id: string;
  type: string;
  text: string;
};

type TaskSnapshot = {
  id: string;
  status: string;
  name?: string;
  summary?: string;
  source?: { repository: string; ref?: string };
  target?: {
    branchName?: string;
    url?: string;
    prUrl?: string;
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTaskSnapshot(id: string): Promise<TaskSnapshot> {
  return apiRequest<TaskSnapshot>("GET", `/v0/agents/${id}`);
}

async function fetchConversationSnapshot(
  id: string
): Promise<{ id: string; messages: ConversationMessage[] }> {
  return apiRequest<{ id: string; messages: ConversationMessage[] }>(
    "GET",
    `/v0/agents/${id}/conversation`
  );
}

async function fetchTaskAndConversation(id: string): Promise<{
  task: TaskSnapshot;
  conversation: { id: string; messages: ConversationMessage[] };
}> {
  const [task, conversation] = await Promise.all([
    fetchTaskSnapshot(id),
    fetchConversationSnapshot(id),
  ]);
  return { task, conversation };
}

const MAX_MESSAGE_TEXT_CHARS = 4000;

function truncateMessageText(text: string): string {
  if (text.length <= MAX_MESSAGE_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_MESSAGE_TEXT_CHARS)}\n…[truncated]`;
}

// Helper function to detect git context
async function detectGitContext(cwd: string): Promise<{
  is_git_repo: boolean;
  repository?: string;
  branch?: string;
  has_uncommitted_changes?: boolean;
}> {
  try {
    await execAsync("git rev-parse --is-inside-work-tree", { cwd });
  } catch {
    return { is_git_repo: false };
  }

  let repository: string | undefined;
  try {
    const { stdout: remoteUrl } = await execAsync("git remote get-url origin", {
      cwd,
    });
    repository = remoteUrl.trim();
    // Convert SSH to HTTPS
    if (repository.startsWith("git@github.com:")) {
      repository = repository
        .replace("git@github.com:", "https://github.com/")
        .replace(/\.git$/, "");
    } else if (repository.endsWith(".git")) {
      repository = repository.replace(/\.git$/, "");
    }
  } catch {
    // Try any remote
    try {
      const { stdout: remotes } = await execAsync("git remote", { cwd });
      const firstRemote = remotes.trim().split("\n")[0];
      if (firstRemote) {
        const { stdout: remoteUrl } = await execAsync(
          `git remote get-url ${firstRemote}`,
          { cwd }
        );
        repository = remoteUrl.trim();
      }
    } catch {
      // No remotes
    }
  }

  let branch: string | undefined;
  try {
    const { stdout } = await execAsync("git branch --show-current", { cwd });
    branch = stdout.trim() || undefined;
    if (!branch) {
      const { stdout: commit } = await execAsync("git rev-parse --short HEAD", {
        cwd,
      });
      branch = `detached@${commit.trim()}`;
    }
  } catch {
    // Ignore
  }

  let has_uncommitted_changes = false;
  try {
    const { stdout } = await execAsync("git status --porcelain", { cwd });
    has_uncommitted_changes = stdout.trim().length > 0;
  } catch {
    // Ignore
  }

  return { is_git_repo: true, repository, branch, has_uncommitted_changes };
}

const SERVER_NAME = "cursor-cloud-agent-mcp";
const SERVER_VERSION = "1.1.0";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  setupServer(server);
  return server;
}

// ============================================================================
// SETUP SERVER
// ============================================================================

export function setupServer(server: McpServer): void {
  // ============================================================================
  // TOOLS: CONTEXT & DISCOVERY (Start here to find repositories)
  // ============================================================================

  server.registerTool(
    "get_repos",
    {
      title: "Get Repositories",
      description: `Get available repositories. First checks if you are in a git directory and returns that repo as "current". Then optionally lists other accessible repos from the API. Call this FIRST before creating tasks to get the repository URL.

**Usage Examples:**
- Basic: Get current repo only: \`get_repos()\`
- Fetch all repos with filter (REQUIRED): \`get_repos({ include_all: true, regex_patterns: ["^my-.*"] })\`
- Filter with multiple patterns (OR): \`get_repos({ include_all: true, regex_patterns: [".*api.*", ".*backend.*"] })\`

**Important:** When using \`include_all: true\`, you MUST provide \`regex_patterns\` to filter the results. This prevents returning too many repositories.

**Workflow:** Use this tool first to discover repositories, then use the repository URL with \`create_task\` to start working on a repo.`,
      inputSchema: {
        include_all: z
          .boolean()
          .optional()
          .describe(
            "Also fetch all accessible repos from API (rate limited: 1/min, 30/hour). Default: false, only returns current git repo if available."
          ),
        working_directory: z
          .string()
          .optional()
          .describe(
            "Directory to check for git repo (defaults to current working directory)"
          ),
        regex_patterns: z
          .array(z.string())
          .optional()
          .describe(
            'Array of regex patterns to filter repositories. Matches repository name, owner, or full URL. Patterns are OR conditions (match if any pattern matches). REQUIRED when include_all is true. Example: ["^my-.*", ".*api.*"]'
          ),
      },
      outputSchema: {
        current: z
          .object({
            repository: z.string(),
            branch: z.string().optional(),
            has_uncommitted_changes: z.boolean().optional(),
          })
          .optional(),
        available: z
          .array(
            z.object({
              owner: z.string(),
              name: z.string(),
              repository: z.string(),
            })
          )
          .optional(),
        message: z.string().optional(),
        filtered_count: z.number().optional(),
        total_count: z.number().optional(),
      },
    },
    async (args) => {
      try {
        const cwd = args.working_directory || process.cwd();
        const gitContext = await detectGitContext(cwd);

        const result: {
          current?: {
            repository: string;
            branch?: string;
            has_uncommitted_changes?: boolean;
          };
          available?: Array<{
            owner: string;
            name: string;
            repository: string;
          }>;
          message?: string;
          filtered_count?: number;
          total_count?: number;
        } = {};

        // Add current repo if in git directory
        let currentRepo:
          | {
              repository: string;
              branch?: string;
              has_uncommitted_changes?: boolean;
            }
          | undefined;
        if (gitContext.is_git_repo && gitContext.repository) {
          currentRepo = {
            repository: gitContext.repository,
            branch: gitContext.branch,
            has_uncommitted_changes: gitContext.has_uncommitted_changes,
          };
        }

        // Fetch all repos if requested
        let allRepos:
          | Array<{ owner: string; name: string; repository: string }>
          | undefined;
        if (args.include_all) {
          // Require filters when fetching all repos
          if (!args.regex_patterns || args.regex_patterns.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: 'Error: You have to add a filter. When using include_all: true, you must provide regex_patterns to filter the results. Example: get_repos({ include_all: true, regex_patterns: ["^my-.*"] })',
                },
              ],
              isError: true,
            };
          }
          try {
            const data = await apiRequest<{
              repositories: Array<{
                owner: string;
                name: string;
                repository: string;
              }>;
            }>("GET", "/v0/repositories");
            allRepos = data.repositories;
            result.total_count = allRepos.length;
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            result.message = `Could not fetch repo list: ${errorMessage}`;
          }
        }

        // Apply regex filtering if patterns provided
        if (args.regex_patterns && args.regex_patterns.length > 0) {
          // Filter current repo
          if (currentRepo) {
            const repoString = `${currentRepo.repository} ${
              currentRepo.branch || ""
            }`.toLowerCase();
            const matches = args.regex_patterns.some((pattern) =>
              matchesRegex(repoString, pattern)
            );
            if (matches) {
              result.current = currentRepo;
            }
          }

          // Filter available repos
          if (allRepos) {
            const filtered = allRepos.filter((repo) => {
              const repoString =
                `${repo.repository} ${repo.owner} ${repo.name}`.toLowerCase();
              return args.regex_patterns!.some((pattern) =>
                matchesRegex(repoString, pattern)
              );
            });
            result.available = filtered;
            result.filtered_count = filtered.length;
          }
        } else {
          // No filtering - return all
          if (currentRepo) {
            result.current = currentRepo;
          }
          if (allRepos) {
            result.available = allRepos;
          }
        }

        // Add helpful message if no current repo
        if (!result.current && !result.available) {
          result.message =
            "Not in a git repository. Call again with include_all: true to list accessible repos (rate limited).";
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_me",
    {
      title: "Get Current User",
      description: `Get API key information including name, creation date, and user email. Use this to verify authentication is working correctly.

**Usage Example:** \`get_me()\`

**Workflow:** Call this first to verify your API key is valid before using other tools.`,
      inputSchema: {},
      outputSchema: {
        apiKeyName: z.string(),
        createdAt: z.string(),
        userEmail: z.string(),
      },
    },
    async () => {
      try {
        const data = await apiRequest<{
          apiKeyName: string;
          createdAt: string;
          userEmail: string;
        }>("GET", "/v0/me");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_models",
    {
      title: "Get Available Models",
      description: `List all available LLM models for cloud tasks. If you omit the model parameter in \`create_task\`, the system will auto-select the most appropriate model.

**Usage Example:** \`get_models()\`

**Workflow:** Use this to see available models, then optionally specify one in \`create_task\`. For most cases, omitting the model parameter (auto-selection) is recommended.`,
      inputSchema: {},
      outputSchema: { models: z.array(z.string()) },
    },
    async () => {
      try {
        const data = await apiRequest<{ models: string[] }>(
          "GET",
          "/v0/models"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );

  // ============================================================================
  // TOOLS: TASK LIFECYCLE (Create, monitor, and manage tasks)
  // ============================================================================

  server.registerTool(
    "create_task",
    {
      title: "Create Cloud Task",
      description: `Launch a new cloud task to work on a repository. By default returns immediately with a pending_id (Cursor API takes ~10s). Poll with get_create_status, then monitor with watch_task.

**Important for remote clients (Perplexity):** Do NOT set wait=true. After create_task, call get_create_status until done, then call watch_task({ id }) repeatedly until done is true — do not wait for the user to ask.

**Usage Examples:**
- Default (fast): \`create_task({ prompt: "...", repository: "https://github.com/owner/repo", ref: "main" })\` → pending_id
- Poll create: \`get_create_status({ pending_id: "..." })\`
- Monitor: \`watch_task({ id: "bc_..." })\` → call again until \`done: true\`
- Blocking (slow): \`create_task({ ..., wait: true })\``,
      inputSchema: {
        prompt: z.string().min(1).describe("Task instructions"),
        repository: z
          .string()
          .url()
          .describe(
            "GitHub repository URL (e.g., https://github.com/owner/repo)"
          ),
        ref: z
          .string()
          .optional()
          .describe("Git branch, tag, or commit to work from"),
        auto_pr: looseBoolean.describe("Auto-create a PR when done (default: false)"),
        branch_name: z
          .string()
          .optional()
          .describe("Custom branch name for the task to create"),
        model: z
          .string()
          .optional()
          .describe("LLM model to use (omit for auto-selection)"),
        plan_file: z
          .string()
          .optional()
          .describe(
            "Path to a plan file to include in the prompt (relative or absolute path)"
          ),
        wait: looseBoolean.describe(
          "If true, block until Cursor returns task id (~10s). Default false — returns pending_id immediately for fast remote clients."
        ),
      },
    },
    async (args) => {
      try {
        console.log("[create_task] start", JSON.stringify(args));
        let planContent: string | undefined;
        if (args.plan_file) {
          try {
            const planPath = resolve(args.plan_file);
            planContent = await readFile(planPath, "utf-8");
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            return {
              content: [
                {
                  type: "text",
                  text: `Error reading plan file: ${errorMessage}`,
                },
              ],
              isError: true,
            };
          }
        }

        const requestBody = buildCreateTaskBody({ ...args, planContent });

        if (args.wait === true) {
          const data = await executeCreateTask(requestBody);
          console.log("[create_task] done (sync)", data.id);
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          };
        }

        const pendingId = randomUUID();
        startCreateTaskAsync(pendingId, args, requestBody);
        const payload = {
          status: "PENDING",
          pending_id: pendingId,
          message:
            "Task submission started. Wait 10-20 seconds, then call get_create_status with this pending_id.",
          started_at: new Date().toISOString(),
        };
        console.log("[create_task] returning pending", pendingId);
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error("[create_task]", errorMessage);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_create_status",
    {
      title: "Get Create Task Status",
      description: `Poll the result of an async create_task submission. Use the pending_id returned by create_task (when wait is not true).

**Workflow:**
1. create_task(...) → returns pending_id
2. Wait 10-20 seconds
3. get_create_status({ pending_id }) → returns task id and agent URL when done`,
      inputSchema: {
        pending_id: z.string().min(1).describe("pending_id from create_task"),
      },
    },
    async (args) => {
      const entry = pendingCreates.get(args.pending_id);
      if (!entry) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Unknown pending_id ${args.pending_id}. It may have expired (server restart) or never existed.`,
            },
          ],
          isError: true,
        };
      }

      const payload = {
        status: entry.status,
        pending_id: args.pending_id,
        ...(entry.result ? { result: entry.result } : {}),
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.status === "pending"
          ? { message: "Still submitting to Cursor API. Try again in 10 seconds." }
          : {}),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: entry.status === "error",
      };
    }
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List Cloud Tasks",
      description: `List all cloud tasks for the authenticated user. Returns comprehensive information including IDs, status, repository, branch, summary, PR URLs, and creation time. Use this to find task IDs for monitoring or follow-up.

**Usage Examples:**
- Basic listing: \`list_tasks()\`
- Filter by status: \`list_tasks({ filter: "FINISHED|RUNNING" })\`
- Filter by repository: \`list_tasks({ filter: ".*my-repo.*" })\`
- Filter by branch name: \`list_tasks({ filter: "feature/.*" })\`
- Filter by summary: \`list_tasks({ filter: ".*README.*" })\`
- Combine filters: \`list_tasks({ filter: "FINISHED.*my-repo" })\`

**Workflow:** After creating tasks with \`create_task\`, use this tool to monitor their status. Then use \`get_task\` for detailed status or \`add_followup\` to send instructions to running tasks.`,
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
        filter: z
          .string()
          .optional()
          .describe(
            'Regex pattern to filter tasks. Searches across all fields (id, name, status, repository, ref, branchName, summary, etc.) concatenated together. Example: "FINISHED|RUNNING" or ".*my-repo.*"'
          ),
      },
      outputSchema: {
        tasks: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            status: z.string(),
            source: z.object({
              repository: z.string(),
              ref: z.string().optional(),
            }),
            target: z.object({
              branchName: z.string().optional(),
              url: z.string().optional(),
              prUrl: z.string().optional(),
              autoCreatePr: z.boolean().optional(),
              openAsCursorGithubApp: z.boolean().optional(),
              skipReviewerRequest: z.boolean().optional(),
            }),
            summary: z.string().optional(),
            createdAt: z.string(),
          })
        ),
        nextCursor: z.string().optional(),
        filtered_count: z.number().optional(),
        total_count: z.number().optional(),
      },
    },
    async (args) => {
      try {
        const params = new URLSearchParams();
        if (args.limit) params.append("limit", args.limit.toString());
        if (args.cursor) params.append("cursor", args.cursor);

        const path = `/v0/agents${params.toString() ? `?${params}` : ""}`;
        const data = await apiRequest<{
          agents: Array<{
            id: string;
            name: string;
            status: string;
            source: { repository: string; ref?: string };
            target: {
              branchName?: string;
              url?: string;
              prUrl?: string;
              autoCreatePr?: boolean;
              openAsCursorGithubApp?: boolean;
              skipReviewerRequest?: boolean;
            };
            summary?: string;
            createdAt: string;
          }>;
          nextCursor?: string;
        }>("GET", path);

        let filteredTasks = data.agents;
        const totalCount = data.agents.length;

        // Apply regex filter if provided
        if (args.filter) {
          filteredTasks = data.agents.filter((task) => {
            // Concatenate all task fields into a single string
            const searchString = [
              task.id,
              task.name,
              task.status,
              task.source.repository,
              task.source.ref || "",
              task.target.branchName || "",
              task.target.url || "",
              task.target.prUrl || "",
              task.summary || "",
              task.createdAt,
              task.target.autoCreatePr?.toString() || "",
              task.target.openAsCursorGithubApp?.toString() || "",
              task.target.skipReviewerRequest?.toString() || "",
            ]
              .join(" ")
              .toLowerCase();

            return matchesRegex(searchString, args.filter!);
          });
        }

        const result = {
          tasks: filteredTasks,
          nextCursor: data.nextCursor,
          ...(args.filter
            ? {
                filtered_count: filteredTasks.length,
                total_count: totalCount,
              }
            : {}),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_task",
    {
      title: "Get Task Status",
      description: `Get the current status and full details of a specific cloud task. Returns comprehensive information including status (CREATING, RUNNING, FINISHED, FAILED, CANCELLED), summary of work done, repository, branch, PR URL if created, and all configuration options.

**Usage Example:** \`get_task({ id: "bc_abc123" })\`

**Status Values:**
- CREATING: Task is being initialized
- RUNNING: Task is actively working
- FINISHED: Task completed successfully
- FAILED: Task encountered an error
- CANCELLED: Task was cancelled

**Workflow:** After creating a task with \`create_task\` or finding one with \`list_tasks\`, use this tool to get detailed status. Check the status field to determine if you need to wait, send follow-ups with \`add_followup\`, or review results.`,
      inputSchema: {
        id: z.string().min(1).describe("Task ID (e.g., bc_abc123)"),
      },
    },
    async (args) => {
      try {
        const data = await apiRequest<Record<string, unknown>>(
          "GET",
          `/v0/agents/${args.id}`
        );

        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "watch_task",
    {
      title: "Watch Task (auto-poll)",
      description: `Monitor a cloud task until it finishes or a short timeout (~8s default). Polls status and conversation internally, returning any new agent messages since your last call.

**For Perplexity / remote clients:** After create_task → get_create_status, call watch_task immediately and keep calling it (pass back known_message_ids from each response) until done is true. Do NOT wait for the user to ask you to poll. Omit timeout_seconds unless needed — default is tuned for Perplexity's ~10s tool timeout.

**Usage:**
1. \`watch_task({ id: "bc_abc123" })\`
2. If \`done: false\`, call again with \`known_message_ids\` from the previous response
3. Repeat until \`done: true\`

Returns: status, new_messages (assistant/user text), pr_url, branch_name, agent_url, and next_step.`,
      inputSchema: {
        id: z.string().min(1).describe("Task ID from create_task / get_create_status"),
        timeout_seconds: looseNumber({
          min: 3,
          max: 15,
          default: 8,
        }).describe(
          "Max seconds to poll before returning (default 8, max 15). Keep low for Perplexity."
        ),
        known_message_ids: looseStringArray.describe(
          "Message IDs already seen — pass known_message_ids from the previous watch_task response"
        ),
      },
    },
    async (args) => {
      try {
        const pollIntervalMs = 2500;
        const maxTimeoutMs = (args.timeout_seconds ?? 8) * 1000;
        const knownIds = new Set(args.known_message_ids ?? []);
        const newMessages: ConversationMessage[] = [];
        const startedAt = Date.now();

        const collectNew = (messages: ConversationMessage[]) => {
          for (const message of messages) {
            if (!knownIds.has(message.id)) {
              newMessages.push({
                ...message,
                text: truncateMessageText(message.text),
              });
              knownIds.add(message.id);
            }
          }
        };

        console.log("[watch_task] start", args.id, "known:", knownIds.size);

        let snapshot = await fetchTaskAndConversation(args.id);
        let task = snapshot.task;
        let conversation = snapshot.conversation;
        collectNew(conversation.messages);

        while (!TERMINAL_TASK_STATUSES.has(task.status)) {
          const elapsedMs = Date.now() - startedAt;
          if (elapsedMs >= maxTimeoutMs) {
            break;
          }

          const remainingMs = maxTimeoutMs - elapsedMs;
          const waitMs = Math.min(pollIntervalMs, remainingMs);
          if (waitMs <= 0) {
            break;
          }

          await sleep(waitMs);

          snapshot = await fetchTaskAndConversation(args.id);
          task = snapshot.task;
          conversation = snapshot.conversation;
          collectNew(conversation.messages);
        }

        const done = TERMINAL_TASK_STATUSES.has(task.status);
        const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
        const payload = {
          id: task.id,
          status: task.status,
          done,
          elapsed_seconds: elapsedSeconds,
          poll_interval_seconds: pollIntervalMs / 1000,
          new_messages: newMessages,
          message_count: conversation.messages.length,
          known_message_ids: [...knownIds],
          name: task.name,
          summary: task.summary,
          agent_url: task.target?.url,
          pr_url: task.target?.prUrl,
          branch_name: task.target?.branchName,
          repository: task.source?.repository,
          next_step: done
            ? "Task complete. Review new_messages and pr_url if present."
            : `Task still ${task.status}. Call watch_task({ id: "${task.id}", known_message_ids: <known_message_ids from this response> }) again immediately.`,
        };

        console.log(
          "[watch_task] done",
          args.id,
          task.status,
          "new_messages:",
          newMessages.length,
          "elapsed:",
          elapsedSeconds
        );

        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error("[watch_task]", errorMessage);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "add_followup",
    {
      title: "Add Follow-up Instruction",
      description: `Send additional instructions to a RUNNING task. Use this to guide the task, request changes, provide clarification, or redirect its work while it is actively running.

**Usage Example:** \`add_followup({ id: "bc_abc123", prompt: "Also add a troubleshooting section" })\`

**Important:** The task must be in RUNNING status. Use \`get_task\` to check status first. If the task is FINISHED, FAILED, or CANCELLED, you cannot send follow-ups.

**Workflow:** 
1. Create a task with \`create_task\`
2. Monitor with \`get_task\` until status is RUNNING
3. Send follow-up instructions as needed
4. Continue monitoring until FINISHED`,
      inputSchema: {
        id: z.string().min(1).describe("Task ID (must be in RUNNING status)"),
        prompt: z.string().min(1).describe("Follow-up instructions"),
      },
      outputSchema: {
        id: z.string(),
      },
    },
    async (args) => {
      try {
        const data = await apiRequest<{ id: string }>(
          "POST",
          `/v0/agents/${args.id}/followup`,
          { prompt: { text: args.prompt } }
        );

        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Get Task Conversation",
      description: `Get the complete conversation history of a task including the original prompt, all follow-ups, and every task response. Useful for reviewing what a task did, understanding its reasoning, and debugging issues.

**Usage Example:** \`get_conversation({ id: "bc_abc123" })\`

**Workflow:** After a task finishes (or fails), use this tool to review the full conversation. This helps you understand what the task did, why it made certain decisions, and what went wrong if it failed. Use \`list_tasks\` to find task IDs, then \`get_conversation\` to review their work.`,
      inputSchema: {
        id: z.string().min(1).describe("Task ID"),
      },
      outputSchema: {
        id: z.string(),
        messages: z.array(
          z.object({
            id: z.string(),
            type: z.string(),
            text: z.string(),
          })
        ),
      },
    },
    async (args) => {
      try {
        const data = await apiRequest<{
          id: string;
          messages: Array<{ id: string; type: string; text: string }>;
        }>("GET", `/v0/agents/${args.id}/conversation`);

        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete Task",
      description: `Permanently delete a cloud task. This action cannot be undone and all conversation history will be lost. Use this to clean up tasks you no longer need.

**Usage Example:** \`delete_task({ id: "bc_abc123" })\`

**Warning:** This permanently deletes the task and all its data. If you want to review the conversation first, use \`get_conversation\` before deleting.

**Workflow:** Use \`list_tasks\` to find tasks, optionally filter them, then delete unwanted ones. Consider reviewing conversations with \`get_conversation\` before deletion if you might need the information later.`,
      inputSchema: {
        id: z.string().min(1).describe("Task ID to delete"),
      },
      outputSchema: {
        id: z.string(),
      },
    },
    async (args) => {
      try {
        const data = await apiRequest<{ id: string }>(
          "DELETE",
          `/v0/agents/${args.id}`
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );

  // ============================================================================
  // PROMPTS (Workflow templates)
  // ============================================================================

  server.registerPrompt(
    "plan-parallel-tasks",
    {
      title: "Plan Parallel Tasks",
      description:
        "Break down a project into parallelizable tasks for multiple cloud tasks. Auto-detects repository context and creates a phased execution plan.",
      argsSchema: {
        project_description: z
          .string()
          .describe("What you want to build or change"),
        repository: z
          .string()
          .optional()
          .describe("Repository URL (auto-detected if omitted)"),
        branch: z
          .string()
          .optional()
          .describe("Base branch (auto-detected if omitted)"),
      },
    },
    ({ project_description, repository, branch }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Plan parallel cloud tasks for this project:

${project_description}

${
  repository
    ? `Repository: ${repository}`
    : "**Step 1**: Call get_repos to detect the current repository"
}
${branch ? `Branch: ${branch}` : ""}

## Instructions

1. **Detect Context**: Use get_repos to find the repository URL and current branch
2. **Analyze**: Break the project into independent tasks
3. **Plan Phases**: Group tasks by dependencies

## Parallelization Rules

**CAN be parallel**: Tasks that modify completely different files
**CANNOT be parallel**: Tasks that modify the same file or depend on each other's output

## Output Format

For each task provide:
- **Task Name**: Short name
- **Files**: List of files to create/modify  
- **Dependencies**: Tasks that must complete first (or "None")
- **Prompt**: Exact text for create_task

Group into phases:
- **Phase 1**: No dependencies (run all in parallel)
- **Phase 2**: Depends on Phase 1 (run in parallel after Phase 1)
- **Phase 3**: Integration (sequential, touches shared files)

After approval, use create_task for each Phase 1 task, then monitor with list_tasks.`,
          },
        },
      ],
    })
  );
}
