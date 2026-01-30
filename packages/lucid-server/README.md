# Lucid Memory

**Claude Code that actually remembers.**

Install once. Use Claude Code normally. It remembers.

```bash
curl -fsSL lucidmemory.dev/install | bash
```

That's it. Restart Claude Code and it just... works.

---

## The Experience

**Before:**

```
You: "Remember that bug we fixed in the auth module?"
Claude: "I don't have context from previous conversations..."
```

**After:**

```
You: "Remember that bug we fixed in the auth module?"
Claude: "Yes - the race condition in the session refresh. We fixed it
by adding a mutex around the token update. That was three weeks ago
when we were refactoring the middleware."
```

No commands. No "save this." No workflow changes. Claude just remembers what matters.

---

## What Gets Remembered

Lucid builds memory automatically from your conversations:

- **Decisions** - "We chose PostgreSQL because..."
- **Bugs & Solutions** - "The race condition was caused by..."
- **Project Context** - "This codebase uses a hexagonal architecture..."
- **Learnings** - "The API requires auth headers on all requests..."

Memories are project-aware. Context from your React app doesn't leak into your Python project.

---

## How It Works

Lucid uses cognitive architecture principles to make memory feel natural:

- **Recent memories surface first** - like human recall
- **Semantically similar memories cluster** - related ideas activate each other
- **Frequently accessed memories strengthen** - important things stick

It's not a database you query. It's memory that works the way memory should.

---

## Privacy

Everything stays local:

- Database lives at `~/.lucid/memory.db`
- Embeddings run locally via Ollama (optional)
- Nothing leaves your machine

---

## For Power Users

If you want direct control, Lucid exposes MCP tools:

```
memory_store    - Explicitly save something
memory_query    - Search your memories
memory_forget   - Remove sensitive data
memory_stats    - See what's stored
```

And a CLI:

```bash
lucid status              # Check system health
lucid stats               # Memory statistics
lucid context "my task"   # Preview what Claude will remember
```

But you probably won't need these. The point is that you don't have to think about it.

---

## Development

```bash
git clone https://github.com/JasonDocton/lucid-memory
cd lucid-memory/packages/lucid-server
bun install
bun test
```

## License

GPL-3.0
