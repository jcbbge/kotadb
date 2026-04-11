# Tool Setup Framework

A systematic process for setting up ANY tool on a new machine.

---

## The Golden Rules

1. **Code lives in git** - Always clone, never create from scratch
2. **Data lives in project dir** - Never `~/Library/` or hidden `~/.` dirs
3. **If it's not in git, back it up manually** - Database files, generated configs
4. **Symlink external repos INTO project dir** - KotADB, etc need to see them

---

## New Machine Checklist

### Phase 1: Git & Dependencies

```bash
# 1. Clone your fork/tools
git clone git@github.com:jcbbge/TOOL.git ~/TOOL

# 2. Install deps (check package.json for "install" or "postinstall")
cd ~/TOOL && bun install   # or npm install, pip install, etc
```

### Phase 2: External Data

```bash
# 1. Create source directory (for cloned repos)
mkdir ~/sourcecode

# 2. Clone anything you want indexed/connected
git clone git@github.com:org/repo.git ~/sourcecode/REPO

# 3. Symlink INTO project dir (if tool requires it)
ln -sf ~/sourcecode/REPO ~/TOOL/app/REPO
```

### Phase 3: Start & Verify

```bash
# 1. Start the tool
cd ~/TOOL && bun run src/index.ts &

# 2. Check health (if HTTP)
curl http://localhost:PORT/health

# 3. Check logs
tail -f ~/.TOOL/logs/output.log
```

### Phase 4: Sync Existing Data (Optional)

```bash
# Only if you have an existing database file to copy
cp OLD_MACHINE:~/.TOOL/data/tool.db NEW_MACHINE:~/.TOOL/data/
```

---

## Port Reference

| Tool | Default Port | Env Var |
|------|--------------|--------|
| KotADB | 3000 | PORT |
| SurrealDB | 8002 | --bind |
| Ollama | 11434 | OLLAMA_HOST |
| ...

---

## Backup & Sync

### Files to Copy Between Machines

| What | Where | How |
|------|-------|-----|
| Tool code | `~/TOOL` | git clone + git pull |
| Indexed data | `~/TOOL/.TOOL/` | scp, rsync |
| Config | `~/.config/TOOL/` | scp, rsync |
| MCP configs | `~/.claude/mcp.json` | scp, rsync |

### Rsync Example

```bash
rsync -avz --exclude='.git' --exclude='node_modules' \
  ~/kotadb/.kotadb/ jcbbge@NEW_MACHINE:~/kotadb/.kotadb/
```

---

## Troubleshooting Stack

When something breaks:

```bash
# 1. Is it running?
lsof -i :PORT          # check port
ps aux | grep TOOL     # check process

# 2. Check logs
tail -100 ~/.TOOL/logs/output.log

# 3. Is data there?
ls -la ~/TOOL/.TOOL/

# 4. Restart
pkill -f TOOL; cd ~/TOOL && bun run src/index.ts &
```

---

## MCP Server Setup

For Claude Code MCP tools:

```json
// ~/.claude/mcp.json
{
  "mcpServers": {
    "TOOL": {
      "command": "bunx",
      "args": ["TOOL@next", "--stdio"]
    }
  }
}
```

Or HTTP (KotADB, etc):

```json
{
  "mcpServers": {
    "TOOL": {
      "type": "http",
      "url": "http://localhost:PORT/mcp"
    }
  }
}
```

---

## Adding New Tools

For every new tool, document:

1. Clone URL: `git@github.com:...`
2. Install: `cd app && bun install`
3. Start: `cd app && bun run src/index.ts`
4. Port: `3000`
5. Data: `.kotadb/kotadb.db` (project-relative)
6. Symlink external? Yes/No - path: `~/sourcecode/X → ~/app/X`

Add new tools to this file.