#!/usr/bin/env bun

/**
 * Lucid Memory MCP Server
 *
 * Minimal, fast MCP server for Claude Code persistent memory.
 * Uses stdio transport for direct integration.
 *
 * Tools:
 * - memory_store: Save something important
 * - memory_query: Search memories
 * - memory_context: Get relevant context for current task
 * - memory_forget: Remove sensitive data
 *
 * Run with: bun run src/server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LucidRetrieval } from "./retrieval.js";
import { detectProvider } from "./embeddings.js";

// === Initialize ===
const retrieval = new LucidRetrieval();

// Try to set up embeddings provider
detectProvider().then(config => {
  if (config) {
    retrieval.setEmbeddingConfig(config);
    console.error(`[lucid] Embedding provider: ${config.provider}`);
  } else {
    console.error("[lucid] No embedding provider found. Memories will work without semantic search.");
  }
});

// Process any pending embeddings in the background
setInterval(async () => {
  try {
    const processed = await retrieval.processPendingEmbeddings(10);
    if (processed > 0) {
      console.error(`[lucid] Processed ${processed} pending embeddings`);
    }
  } catch (error) {
    console.error("[lucid] Error processing embeddings:", error);
  }
}, 5000);

// === Create MCP Server ===
const server = new McpServer({
  name: "lucid-memory",
  version: "0.1.0",
  capabilities: {
    tools: {},
  },
});

// === Register Tools ===

/**
 * memory_store - Save something important to remember
 */
server.tool(
  "memory_store",
  "Store something important to remember. Use this proactively when you learn something useful about the project, solve a bug, make a decision, or encounter context that might be valuable later.",
  {
    content: z.string().describe("What to remember - be specific and include context"),
    type: z.enum(["learning", "decision", "context", "bug", "solution", "conversation"])
      .optional()
      .default("learning")
      .describe("Type of memory"),
    gist: z.string().optional().describe("Short summary (generated automatically if not provided)"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
    emotionalWeight: z.number().min(0).max(1).optional()
      .describe("How important is this? 0-1, higher = more important"),
    projectPath: z.string().optional().describe("Project path for project-specific memories"),
  },
  async ({ content, type, gist, tags, emotionalWeight, projectPath }) => {
    try {
      // Get or create project if path provided
      let projectId: string | undefined;
      if (projectPath) {
        const project = retrieval.storage.getOrCreateProject(projectPath);
        projectId = project.id;
      }

      const memory = await retrieval.store(content, {
        type,
        gist,
        tags,
        emotionalWeight,
        projectId,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            id: memory.id,
            message: `Stored: "${content.slice(0, 50)}${content.length > 50 ? "..." : ""}"`,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  }
);

/**
 * memory_query - Search for relevant memories
 */
server.tool(
  "memory_query",
  "Search for relevant memories. Use when you need to recall past learnings, decisions, bugs, or context.",
  {
    query: z.string().describe("What to search for - natural language"),
    limit: z.number().min(1).max(20).optional().default(5).describe("Max results"),
    type: z.enum(["learning", "decision", "context", "bug", "solution", "conversation"])
      .optional()
      .describe("Filter by memory type"),
    projectPath: z.string().optional().describe("Filter by project path"),
  },
  async ({ query, limit, type, projectPath }) => {
    try {
      // Get project ID if path provided
      let projectId: string | undefined;
      if (projectPath) {
        const project = retrieval.storage.getOrCreateProject(projectPath);
        projectId = project.id;
      }

      const results = await retrieval.retrieve(query, {
        maxResults: limit,
        filterType: type,
      }, projectId);

      if (results.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              message: "No memories found matching your query.",
              suggestions: [
                "Try broader search terms",
                "Check if memories exist for this project",
                "Store relevant context first with memory_store",
              ],
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: results.length,
            memories: results.map(r => ({
              id: r.memory.id,
              content: r.memory.content,
              type: r.memory.type,
              relevance: Math.round(r.score * 100) / 100,
              tags: r.memory.tags,
              createdAt: new Date(r.memory.createdAt).toISOString(),
            })),
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  }
);

/**
 * memory_context - Get relevant context for current task
 */
server.tool(
  "memory_context",
  "Get memories relevant to your current task. Call this at the start of conversations or when context would help.",
  {
    currentTask: z.string().describe("What you're currently working on"),
    projectPath: z.string().optional().describe("Current project path"),
  },
  async ({ currentTask, projectPath }) => {
    try {
      // Get project ID if path provided
      let projectId: string | undefined;
      if (projectPath) {
        const project = retrieval.storage.getOrCreateProject(projectPath);
        projectId = project.id;
      }

      const context = await retrieval.getContext(currentTask, projectId);

      if (context.memories.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              message: "No relevant context found.",
              hint: "As you learn things about this project, use memory_store to build up context.",
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            summary: context.summary,
            relevantMemories: context.memories.map(r => ({
              content: r.memory.content,
              type: r.memory.type,
              relevance: Math.round(r.score * 100) / 100,
            })),
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  }
);

/**
 * memory_forget - Remove a memory (for sensitive data)
 */
server.tool(
  "memory_forget",
  "Remove a memory. Use this to delete sensitive information that shouldn't be retained.",
  {
    memoryId: z.string().describe("ID of the memory to remove"),
  },
  async ({ memoryId }) => {
    try {
      const deleted = retrieval.storage.deleteMemory(memoryId);

      if (!deleted) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              message: "Memory not found",
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: "Memory removed",
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  }
);

/**
 * memory_stats - Get memory system statistics
 */
server.tool(
  "memory_stats",
  "Get statistics about the memory system.",
  {},
  async () => {
    try {
      const stats = retrieval.storage.getStats();

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            memories: stats.memoryCount,
            withEmbeddings: stats.embeddingCount,
            associations: stats.associationCount,
            projects: stats.projectCount,
            dbSizeKB: Math.round(stats.dbSizeBytes / 1024),
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: String(error) }),
        }],
        isError: true,
      };
    }
  }
);

// === Start Server ===
async function main() {
  const transport = new StdioServerTransport();

  console.error("[lucid] Starting Lucid Memory MCP server...");

  await server.connect(transport);

  console.error("[lucid] Server connected. Ready for Claude Code.");
}

main().catch(error => {
  console.error("[lucid] Fatal error:", error);
  process.exit(1);
});
