---
name: bootstrap
description: Bootstrap your first domain agent by exploring the codebase and invoking agent-builder
argument-hint: [domain-area or leave blank for auto-discovery]
allowed-tools: Read, Glob, Grep, Bash
user-invocable: true
---

# Bootstrap — Create Your First Domain Agent

You are helping the user bootstrap their agentic layer by exploring the project codebase and suggesting which expert agents to create.

## Instructions

### Step 1: Explore the Project

Discover the project's structure and technology stack:

1. List the top-level directories to understand the project layout
2. Look for key configuration files that reveal the stack:
   - `package.json`, `tsconfig.json` (Node/TypeScript)
   - `Cargo.toml` (Rust)
   - `pyproject.toml`, `requirements.txt` (Python)
   - `go.mod` (Go)
   - `pom.xml`, `build.gradle` (Java)
   - `docker-compose.yml`, `Dockerfile` (containerized services)
   - `turbo.json`, `pnpm-workspace.yaml` (monorepo)
3. Identify major domains: API/backend, frontend/UI, database, infrastructure, testing
4. Read `CLAUDE.md` if it exists for project context

If the user provided a domain hint via `$ARGUMENTS`, focus exploration on that area.

### Step 2: Suggest Candidate Agents

Based on the discovered structure, suggest 3-5 candidate expert agents. For each, provide:

- **Agent name** (lowercase, hyphens)
- **Role** (1-2 sentence description)
- **Recommended model** (opus for deep reasoning, sonnet for implementation, haiku for lightweight)
- **Key files/directories** it would own

Present these as a numbered list and ask the user which agent(s) to create first.

### Step 3: Delegate to Agent Builder

For the user's chosen agent, tell them to run:

```
/agent-builder Create a new expert agent for [chosen domain]. Key directories: [list]. Suggested model: [model].
```

The agent-builder will handle creating the settings.json entry, agent markdown, and expertise.yaml.

## Tips

- Start with the agent that covers the largest or most active area of the codebase
- For monorepos, consider one agent per package/service
- Advisory agents (domain experts, security reviewers) should be `independent` with `permissionMode: plan`
- Implementation agents (frontend, backend, API) should be `collaborative`
- After the first agent is created, you can invoke `/agent-builder` directly for subsequent agents
