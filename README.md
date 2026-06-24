# Daedalus MCP

Daedalus MCP is a local Model Context Protocol (MCP) server for creating and running specialized engineering agents per project or workspace.

It is designed for workspaces that may contain:

- a single backend service;
- several related microservices;
- a frontend + BFF + backend setup;
- a monorepo or folder with multiple related projects.

Daedalus scans the current workspace, detects the projects and their technologies, creates reusable agent templates, generates project-specific rules/knowledge, and lets you run sequential agent pipelines such as planning, rules validation, performance review, and architecture review.

## Main idea

Given a workspace like:

```txt
workspace/
  catalog/
  data-mirror/
  vendors-bff/
  admin-ui/
```

Daedalus can detect stacks such as Java/Spring Boot or Angular and create:

```txt
workspace/
  .engineering-agents/
    workspace.agents.yaml

  catalog/
    agents.config.yaml
    agents/
      plan/
      rules/
      performance/
      architecture/

  admin-ui/
    agents.config.yaml
    agents/
      plan/
      rules/
      performance/
      architecture/
```

Reusable templates live inside this MCP project:

```txt
templates/
  java21-spring-boot-plan/
  typescript-angular-plan/
  project-rules-validator/
  performance-jvm/
  performance-web-node/
  architecture-microservice/
  architecture-frontend/
```

Daedalus does **not overwrite existing files by default**.

## Available MCP prompts / slash commands

Daedalus also registers MCP prompts named `daedalus` and `daedalus-init`. In clients that expose MCP prompts as slash commands, you can use:

```txt
/daedalus init
/daedalus listProjects
/daedalus plan --group:java-all "agregar healthcheck estándar"
/daedalus review --group:java-all "revisar el diff actual"
```

If the client says the slash command does not exist, use natural language or the `daedalus` tool directly, for example: “Use Daedalus and run `/daedalus init`”. Slash command availability is controlled by the host client, not by the MCP server alone.

## Available MCP tools

### `daedalus_init`

Scans the current workspace and initializes agents.

Equivalent slash-style command:

```txt
/daedalus init
```

What it does:

1. Detects the current workspace from MCP roots or `cwd`.
2. Finds projects inside the workspace.
3. Detects language, framework, build tool, package manager and architecture.
4. Creates missing reusable templates.
5. Creates `agents.config.yaml` and `agents/` inside each detected project.
6. Creates workspace groups like `all`, `java-all`, `angular-all`, etc.

Options:

```ts
{
  workspacePath?: string,
  force?: boolean,
  refreshProjectKnowledge?: boolean,
  refreshTemplates?: boolean,
  maxDepth?: number
}
```

### `daedalus_listProjects`

Lists projects detected by the last init.

Slash-style command:

```txt
/daedalus listProjects
```

### `daedalus_listGroups`

Lists generated project groups.

Slash-style command:

```txt
/daedalus listGroups
```

Examples of groups:

```txt
all
java-all
java21-spring-boot-all
spring-boot-all
angular-all
typescript-all
```

### `daedalus_run`

Runs an agent pipeline over a group or selected projects.

Slash-style examples:

```txt
/daedalus plan --group:java-all "agregar healthcheck estándar"
```

```txt
/daedalus plan --group:angular-all "agregar healthcheck estándar"
```

```txt
/daedalus plan --group:all "agregar healthcheck estándar"
```

```txt
/daedalus plan --project [catalog,data-mirror,vendors-bff] "agregar healthcheck estándar"
```

The report includes the response from every agent for every selected project.

Default `plan` pipeline:

```txt
plan -> rules -> performance -> architecture
```


### `daedalus_review`

Runs the code-review pipeline over a group or selected projects. It reviews code, diffs, files or change descriptions using language/framework best practices and project-specific rules.

Slash-style examples:

```txt
/daedalus review --group:java-all "revisar el diff actual"
```

```txt
/daedalus review --project [catalog,data-mirror] "revisar cambios de healthcheck"
```

Default `review` pipeline:

```txt
code-review -> rules -> performance -> architecture
```

### `daedalus`

Convenience parser for slash-style commands.

Input example:

```json
{
  "command": "/daedalus plan --group:java-all \"agregar healthcheck estándar\""
}
```

Legacy aliases `agent` and `agent_init` are also available, but `/daedalus` is preferred.

## Installation from local checkout

### 1. Clone the repository

```bash
git clone https://github.com/daedalus/daedalus-mcp.git
cd daedalus-mcp
```

> Replace the URL with the real repository URL if different.

### 2. Install dependencies

```bash
npm install
```

### 3. Build

```bash
npm run build
```

### 4. Link the local binary

```bash
npm link
```

This exposes:

```bash
daedalus-mcp
```

Verify:

```bash
which daedalus-mcp
```

If your MCP client does not inherit your shell `PATH`, use the absolute path returned by `which daedalus-mcp`.

## Add to Codex

Edit:

```bash
~/.codex/config.toml
```

Add:

```toml
[mcp_servers.daedalus]
command = "daedalus-mcp"
startup_timeout_sec = 60
```

If Codex cannot find `daedalus-mcp`, use the absolute path:

```toml
[mcp_servers.daedalus]
command = "/absolute/path/to/daedalus-mcp"
startup_timeout_sec = 60
```

Restart Codex.


## Claude Code slash command `/daedalus`

Claude Code slash commands are client-side prompt files. If `/daedalus` is not recognized even though the MCP server is running, create this user-level command:

```bash
mkdir -p ~/.claude/commands
cat > ~/.claude/commands/daedalus.md <<'EOF'
---
description: Run Daedalus MCP commands
allowed-tools: mcp__daedalus__daedalus, mcp__daedalus__daedalus_init, mcp__daedalus__daedalus_listProjects, mcp__daedalus__daedalus_listGroups, mcp__daedalus__daedalus_run
---

Use the Daedalus MCP server. Run the MCP tool `daedalus` with:

```json
{ "command": "/daedalus $ARGUMENTS" }
```

If `$ARGUMENTS` is empty, use `/daedalus init`. Summarize the MCP result for the user.
EOF
```

Restart Claude Code after creating or changing this file. Then use:

```txt
/daedalus init
/daedalus listProjects
/daedalus plan --group:java-all "agregar healthcheck estándar"
/daedalus review --group:java-all "revisar el diff actual"
```

## Add to Claude Desktop

Edit:

```bash
~/Library/Application Support/Claude/claude_desktop_config.json
```

Add the server inside `mcpServers`:

```json
{
  "mcpServers": {
    "daedalus": {
      "command": "daedalus-mcp"
    }
  }
}
```

If Claude cannot find `daedalus-mcp`, use the absolute path:

```json
{
  "mcpServers": {
    "daedalus": {
      "command": "/absolute/path/to/daedalus-mcp"
    }
  }
}
```

Restart Claude Desktop.

## Prompt to install from another Codex/Claude chat

Once this project is published, you can open a new Codex or Claude chat and say something like:

```txt
Install the Daedalus MCP from https://github.com/daedalus/daedalus-mcp.
Clone it, run npm install, npm run build, npm link, and add it as an MCP server named daedalus using the daedalus-mcp command. Then restart or tell me to restart the client.
```

For Codex specifically:

```txt
Install the MCP server from https://github.com/daedalus/daedalus-mcp and add this to ~/.codex/config.toml:

[mcp_servers.daedalus]
command = "daedalus-mcp"
startup_timeout_sec = 60
```

For Claude Desktop specifically:

```txt
Install the MCP server from https://github.com/daedalus/daedalus-mcp and add it to ~/Library/Application Support/Claude/claude_desktop_config.json under mcpServers as:

"daedalus": {
  "command": "daedalus-mcp"
}
```

## Typical usage

After adding the MCP server and restarting the client, open a chat in the target workspace and run:

```txt
Use Daedalus and run /daedalus init
```

Then inspect what was detected:

```txt
Use Daedalus and run /daedalus listProjects
```

```txt
Use Daedalus and run /daedalus listGroups
```

Run a plan for all Java projects:

```txt
Use Daedalus and run /daedalus plan --group:java-all "agregar healthcheck estándar"
```

Run a code review for all Java projects:

```txt
Use Daedalus and run /daedalus review --group:java-all "revisar el diff actual"
```

Run a plan for specific projects:

```txt
Use Daedalus and run /daedalus plan --project [catalog,data-mirror,vendors-bff] "agregar healthcheck estándar"
```

## Generated files

### Workspace config

```txt
.engineering-agents/workspace.agents.yaml
```

Contains detected projects and groups.

### Per-project config

```txt
agents.config.yaml
```

Contains project metadata, agents and pipelines.

### Per-project agents

```txt
agents/
  plan/
    prompt.md
    agent.yaml
    knowledge/
      general/
      project/
  rules/
  performance/
  architecture/
```

### Reusable templates

```txt
templates/
```

Templates are shared by technology/version/architecture and reused across projects.

## Development

```bash
npm install
npm run build
```

Run directly:

```bash
npm start
```

Type-check:

```bash
npx tsc --noEmit
```

## Notes

- Daedalus uses MCP `roots/list` when available to identify the workspace opened in the client.
- If roots are unavailable, it falls back to the process `cwd`.
- `workspacePath` can be provided manually as an override.
- Existing generated files are preserved by default. If a previous init generated stale project knowledge, rerun init with `refreshProjectKnowledge: true` to regenerate generated `knowledge/general` and `knowledge/project` files.
- Pipeline execution uses MCP sampling when the host supports it. Some hosts return `MCP error -32601: Method not found` for sampling; in that case Daedalus now catches it and returns a handoff report with the prepared agent prompts/context so the host assistant can execute the reasoning in its final response.
