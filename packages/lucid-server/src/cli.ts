#!/usr/bin/env bun

/**
 * Lucid Memory CLI
 *
 * Simple CLI for hook integration and manual operations.
 *
 * Usage:
 *   lucid context "what I'm working on"      - Get relevant context
 *   lucid store "content" --type learning    - Store a memory
 *   lucid stats                              - Show memory stats
 *   lucid status                             - Check system status
 */

import { LucidRetrieval } from "./retrieval.js";
import { detectProvider } from "./embeddings.js";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  const retrieval = new LucidRetrieval();

  // Try to set up embeddings
  const embeddingConfig = await detectProvider();
  if (embeddingConfig) {
    retrieval.setEmbeddingConfig(embeddingConfig);
  }

  switch (command) {
    case "context": {
      const task = args[1] || "";
      const projectPath = args.find(a => a.startsWith("--project="))?.split("=")[1];

      if (!task) {
        console.error("Usage: lucid context 'what you're working on' [--project=/path]");
        process.exit(1);
      }

      let projectId: string | undefined;
      if (projectPath) {
        const project = retrieval.storage.getOrCreateProject(projectPath);
        projectId = project.id;
      }

      const context = await retrieval.getContext(task, projectId);

      if (context.memories.length === 0) {
        // Output nothing - no relevant context
        process.exit(0);
      }

      // Output context in a format suitable for injection
      console.log("<lucid-context>");
      console.log(context.summary);
      for (const candidate of context.memories) {
        console.log(`- [${candidate.memory.type}] ${candidate.memory.content.slice(0, 200)}`);
      }
      console.log("</lucid-context>");
      break;
    }

    case "store": {
      const content = args[1];
      if (!content) {
        console.error("Usage: lucid store 'content to remember' [--type=learning] [--project=/path]");
        process.exit(1);
      }

      const typeArg = args.find(a => a.startsWith("--type="))?.split("=")[1];
      const type = (typeArg as any) || "learning";
      const projectPath = args.find(a => a.startsWith("--project="))?.split("=")[1];

      let projectId: string | undefined;
      if (projectPath) {
        const project = retrieval.storage.getOrCreateProject(projectPath);
        projectId = project.id;
      }

      const memory = await retrieval.store(content, { type, projectId });
      console.log(JSON.stringify({ success: true, id: memory.id }));
      break;
    }

    case "stats": {
      const stats = retrieval.storage.getStats();
      console.log(`Memories: ${stats.memoryCount}`);
      console.log(`With embeddings: ${stats.embeddingCount}`);
      console.log(`Associations: ${stats.associationCount}`);
      console.log(`Projects: ${stats.projectCount}`);
      console.log(`Database size: ${Math.round(stats.dbSizeBytes / 1024)} KB`);
      break;
    }

    case "status": {
      const stats = retrieval.storage.getStats();
      const hasEmbeddings = embeddingConfig !== null;

      console.log("🧠 Lucid Memory Status");
      console.log("");
      console.log(`Memories: ${stats.memoryCount}`);
      console.log(`Embeddings: ${hasEmbeddings ? "✓ Active" : "✗ No provider"}`);
      if (hasEmbeddings && embeddingConfig) {
        console.log(`  Provider: ${embeddingConfig.provider}`);
        console.log(`  Model: ${embeddingConfig.model}`);
      }
      console.log(`Database: ~/.lucid/memory.db (${Math.round(stats.dbSizeBytes / 1024)} KB)`);
      break;
    }

    case "help":
    case "--help":
    case "-h":
    default: {
      console.log(`
Lucid Memory CLI

Commands:
  context <task> [--project=/path]   Get relevant context for a task
  store <content> [--type=TYPE]      Store a memory (types: learning, decision, context, bug, solution)
  stats                              Show memory statistics
  status                             Check system status

Examples:
  lucid context "implementing auth" --project=/my/project
  lucid store "Auth uses JWT tokens stored in httpOnly cookies" --type=decision
  lucid status
      `);
      break;
    }
  }
}

main().catch(error => {
  console.error("Error:", error.message);
  process.exit(1);
});
