# AI Agent One — a self-scaffolding agent platform

Most AI tools make you fit your problem to their interface. Agent One works
the other way round.

You describe the agent you want: its character, the topics it should focus
on, and the outputs you'd like back. The platform then builds it: the system
prompt, the persona and the tools, including Python implementations written
on the spot. A researcher on grid storage, an analyst comparing two
frameworks, a historian of the Roman era. Each one is purpose-built on
demand, with no code changes between them.

Once deployed, the agent leads a small team. A research turn is split across
2–3 worker agents (by angle or by topic), each bootstrapped with its own
persona and tools. The main agent then writes one report from what they
found, rather than repeating each worker's findings. Every step, from model
calls to tool calls, workers and self-checks, is recorded in a case file you
can open under each reply.

The "agent as spy" theming (dossiers, case files, commissions) is deliberate.

---

## What it does

### 1. Build the agent (Setup)

Setup is four steps, drawn as a live process graph as you go:

| Step | What happens |
| --- | --- |
| **Character** | Agent type (General Task, Researcher, Job search), plus stackable personality and behaviour pills (Concise, Skeptical, Cite Sources, Proactive, …). |
| **Focus** | The topics the agent works on. Smart Focus embeds them to flag near-duplicate topics and suggest related ones you've saved before. |
| **Brief** | An LLM drafts a short brief interpreting what the chosen topics mean together, plus a graph of how the agent will approach the job. |
| **Outputs** | The agent proposes 3–5 deliverables for the job (report, chart, spreadsheet, slide deck, …), with its own picks pre-ticked. |

**Deploy** then streams the bootstrap: grounding, design, one node per
generated tool, code checks and self-checks. Saved agent profiles can be
reloaded with **Load Agent**. A profile that has already been built
relaunches without bootstrapping again.

**Advanced Setup** keeps the agent's intent as a structured spec (mission,
success criteria, out-of-scope topics, allowed tools, limits). It routes each
field to the layer that can actually enforce it. Before launch you can
review and edit the generated config, which is re-validated server-side.

### 2. Run it (Deploy)

- **Streaming agent loop.** Tool calls, worker cards and status messages
  ("Reviewing tool results…") stream live, so background work never looks
  stalled.
- **Teams of workers.** Workers run concurrently, and each shows the task it
  was given, its tools and its response. The main agent writes the combined
  report itself.
- **Diagrams over prose.** Comparisons, breakdowns and processes come back
  as Mermaid charts rendered in the reply.
- **Outputs.** Any answer can be exported as CSV, diagram, chart, Markdown,
  PDF, Word, slides or JSON. The deliverables chosen in Setup are always
  offered. A whole conversation exports to a PDF that matches the on-screen
  view.
- **Next moves.** Each reply ends with 2–4 suggested next steps, as buttons.
- **Case file.** A waterfall of every span in the turn, with model, timing
  and tokens. "How this agent was made" shows the bootstrap the same way:
  similar past agents used for grounding, tools proposed, what the code
  checks caught and what was fixed or dropped.
- **Resume.** A saved conversation reopens with a "Previously…" recap
  written by the agent in character.

---

## How it works

```text
┌──────────────────────────────────────────────────────────────────┐
│ Phase 1: Bootstrap  (POST /bootstrap, streamed NDJSON)           │
│                                                                  │
│ purpose + spec ──► LLM generates AgentConfig                     │
│   • system_prompt, persona                                       │
│   • tools[]: a generated Python implementation, OR a reference   │
│     to a real tool on a vetted MCP server (source: "mcp")        │
│ Grounded by: similar past bootstraps (embedding retrieval)       │
│              + the live catalog of vetted MCP tools              │
│ Then: compile / forbidden-call / undefined-name (AST) checks,    │
│       one retry, then drop; spec rules enforced in code          │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ Phase 2: Agent loop  (POST /agent, streamed NDJSON)              │
│                                                                  │
│ message ──► LLM with the agent's tools                           │
│   ├─ generated tool     → sandboxed child process                │
│   ├─ source: "mcp"      → the real MCP server                    │
│   ├─ delegate_to_worker → bootstrap + run a worker (concurrent)  │
│   └─ final reply        → self-checks, scope guard → UI          │
└──────────────────────────────────────────────────────────────────┘
```

The backend is stateless for conversations: the full history and
`AgentConfig` travel with every request.

A bootstrapped agent can also be **published** as an MCP tool
(`backend/mcp_server.py`, a separate process). Any MCP client, such as
Claude Desktop, Claude Code or another app, can then call it directly.
Publishing is an explicit step, never automatic.

---

## AI features in more detail

| Feature | What it does | Code |
| --- | --- | --- |
| Provider cascade | Gemini → Cloudflare Workers AI (hosted Qwen) → Ollama (local). The provider and model are chosen per agent in Settings. | `llm_client.py` |
| Bootstrap grounding (RAG) | Past `purpose → config` pairs are embedded and the closest are given to the model as few-shot examples. | `bootstrap_memory.py`, `embeddings.py` |
| Vetted MCP tools | The model can pick a real tool (time, fetch, Tavily web search) instead of writing one. | `mcp_registry.py`, `mcp_client.py` |
| Generated-code checks | Deterministic checks catch calls to tools that don't exist, invented helper names (AST), and fake localhost proxies before the agent runs. | `bootstrap.py` |
| Sandbox | Each generated tool call runs in a fresh `python -I` process with a scrubbed environment (no secrets), a timeout, rlimits, an import allowlist, and no network unless the code uses it. | `sandbox.py`, `sandbox_runner.py` |
| Structured spec | Persona, tool allow-lists and limits are enforced in code; mission and scope are restated to the model every turn. | `agent_spec.py` |
| Scope guard | A separate judge call screens replies against out-of-scope topics. It allows one regenerate, then substitutes a decline written in code. | `scope_guard.py` |
| Self-checks | Every bootstrap, reply, tool call and delegation is graded and tagged with the provider/model that produced it. | `eval_checks.py`, `eval_log.py` |
| Model recommendation | UCB1 bandit over that history; Settings shows a "data-backed pick". Advisory only, never auto-selected. | `bandit.py` |
| Offline evals | Fixed cases × model arms × repeats. Chat cases replay recorded tool responses, so runs are repeatable. Results go to a scoreboard. | `eval_harness.py`, `eval_replay.py`, `eval_cases/` |
| Run trace | Timed spans for every model call, tool and worker, streamed to the case file and logged for production timing. | `run_trace.py`, `CaseFile.tsx` |
| Brief, outputs, Smart Focus | The Setup steps that interpret the job before anything is built. | `brief.py`, `focus_insights.py` |
| Outputs (relics) | Builds files from an answer or from the brief. | `relic.py` |

---

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 18, TypeScript, Vite, React Flow (`@xyflow/react`) for the graphs, `react-markdown` + `mermaid`, `jspdf`, Leaflet |
| Backend | Python, Flask + gunicorn (chat/bootstrap API), plus a separate uvicorn/Starlette process for the MCP server |
| Storage | One SQLite database (`DATA_DIR/agentone.db`, WAL mode) for bootstrap memory, eval history, published agents, saved profiles and rate limits. Conversations are saved in the browser. |
| AI | Gemini, Cloudflare Workers AI, Ollama; the official `mcp` SDK (stdio and Streamable HTTP) |
| Hosting | systemd + nginx on a droplet (`agent.carkus.com`), shipped by tarball over SSH |

An AWS SAM/Lambda path (`template.yaml`, `backend/src/handler.py`) is still
in the repo as dev-only tooling (`sam local`). It is not deployed.

---

## Project structure

```text
AIAgentOne/
├── backend/
│   ├── server.py              # Flask app (dev + prod): /bootstrap, /agent, /brief*, /relic, /recap, /models, /agents, …
│   ├── mcp_server.py          # Separate ASGI process: published agents as MCP tools
│   ├── eval_harness.py        # Offline eval runner (--suite bootstrap | chat)
│   ├── eval_replay.py         # Tool-response tape for repeatable chat evals
│   ├── eval_cases/            # Eval cases and frozen chat fixtures
│   └── src/
│       ├── bootstrap.py       # Streams the bootstrap; grounding, validators, retry/drop
│       ├── agent_stream.py    # The agent loop: tools, delegation, self-checks, scope guard
│       ├── orchestrator.py    # Bootstraps and runs a delegated worker
│       ├── llm_client.py      # Gemini → Workers AI → Ollama cascade
│       ├── agent_spec.py      # Advanced Setup's spec: prompt block, post-gen enforcement, runtime gates
│       ├── scope_guard.py     # Out-of-scope output judge
│       ├── sandbox.py         # Per-call process isolation for generated tools
│       ├── sandbox_runner.py  # The sandboxed child process
│       ├── tools.py           # Primitive tools (fetch_page, search_jobs, images, save_output)
│       ├── brief.py           # Setup's brief, brief graph and proposed outputs
│       ├── focus_insights.py  # Smart Focus (embedding similarity)
│       ├── relic.py           # Output files: CSV, chart, PDF, DOCX, slides, …
│       ├── recap.py           # "Previously…" recap for a resumed chat
│       ├── run_trace.py       # Timed spans for the case file
│       ├── eval_checks.py, eval_log.py, bandit.py, agent_stats.py
│       ├── bootstrap_memory.py, embeddings.py
│       ├── mcp_registry.py, mcp_client.py, agent_registry.py
│       ├── agent_drafts.py, saved_searches.py
│       ├── db.py              # Shared SQLite database
│       ├── rate_limit.py      # Per-IP limits, shared across workers via SQLite
│       └── handler.py, agent.py  # SAM/Lambda path, dev-only
├── frontend/src/
│   ├── App.tsx                # Phases: setup → bootstrapping → chat
│   ├── api.ts, types.ts
│   └── components/
│       ├── Setup.tsx, ProcessGraph.tsx, BriefGraph.tsx, ColumnGraph.tsx
│       ├── AdvancedSetup.tsx, AgentPool.tsx (Load Agent), SettingsModal.tsx
│       ├── Chat.tsx, ToolActivity.tsx, GraphView.tsx, CaseFile.tsx
│       ├── AgentMakingReport.tsx, ScoreboardModal.tsx, MermaidDiagram.tsx
│       └── …
├── deploy/                    # redeploy.sh, systemd units, nginx config
├── CLAUDE.md                  # Full architecture notes and design decisions
├── RUN.md                     # Local setup, step by step
└── DEPLOY.md                  # Droplet setup
```

---

## Running locally

Full first-time setup is in [`RUN.md`](./RUN.md). Short version:

```bash
# Backend, from the repo root (reads credentials from env.json / .env)
python backend/server.py          # http://localhost:4891

# Frontend, in a second terminal
cd frontend && npm install && npm run dev   # http://localhost:5273

# Optional: the MCP server, in a third terminal
python backend/mcp_server.py      # http://localhost:4892/mcp
```

The Vite dev server proxies the API routes to `localhost:4891`.

**Prerequisites:** Python 3.12+, Node.js 18+, and at least one model
provider: a Gemini API key, a Cloudflare Workers AI account, or
[Ollama](https://ollama.com/) running locally. With Ollama, set
`OLLAMA_CONTEXT_LENGTH=16384` on the Ollama server; Ollama ignores the API's
context setting, and prompts are otherwise cut to about 2k tokens.

---

## Deployment

Production is a systemd + nginx droplet, not AWS. See
[`DEPLOY.md`](./DEPLOY.md).

```bash
deploy/redeploy.sh backend    # sync backend, restart aiagent + aiagent-mcp
deploy/redeploy.sh frontend   # build locally, ship dist/
deploy/redeploy.sh all
```

- `gunicorn server:app`: 1 worker × 16 threads (`aiagent` unit)
- `uvicorn mcp_server:app`: its own `aiagent-mcp` unit, proxied at `/mcp`
- nginx serves the frontend and proxies both; one HTTP Basic Auth login
  gates the whole app
- No Ollama in production; chat uses Gemini and Workers AI

---

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Gemini for chat, bootstrap, embeddings and images |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Workers AI (hosted Qwen) in the chat cascade; also an image fallback |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | Local Ollama (dev) |
| `DISABLE_OLLAMA` | `1` removes Ollama from the cascade and the model list |
| `LLM_PROVIDER` | Force one provider, e.g. `ollama` |
| `TAVILY_API_KEY` | Enables the vetted Tavily web-search MCP server |
| `HF_API_TOKEN` | Hugging Face image-generation fallback |
| `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | `search_jobs` primitive (job-search agent type) |
| `MCP_API_KEY` | API key for `/mcp`, independent of the site login |
| `MCP_PORT`, `PORT` | Dev ports (defaults 4892, 4891) |
| `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_PER_DAY` | Per-IP limits on paid-provider calls (Ollama exempt) |
| `TOOL_SANDBOX_TIMEOUT_SECONDS`, `TOOL_SANDBOX_MEMORY_MB`, `TOOL_SANDBOX_CPU_SECONDS` | Sandbox limits |
| `DATA_DIR` | Where `agentone.db` lives |

See `.env.example` for a starting point.

---

## Current limitations

1. **Sandbox is a process, not a container.** Generated code runs in a
   child process with no secrets, a timeout and (on Linux) rlimits and no
   network unless declared. Code that escapes the Python-level layer can
   still read files the service user can read, and a network tool can reach
   any host. Next step: a separate low-privilege user or container per call,
   and an egress allowlist.
2. **Conversations are saved in the browser only.** Saved chats live in
   `localStorage` and don't follow you across devices. Agent profiles and
   published agents are stored server-side.
3. **Authentication is perimeter-only.** One shared login gates the
   deployed app; there are no per-user accounts.
4. **File output is ephemeral.** `save_output` files are written to the
   server's temp directory and are lost on restart.
5. **Out-of-scope is judged, not guaranteed.** Persona, tool lists and
   limits are enforced in code. Meaning-level rules (mission, out-of-scope)
   are asked of the model and screened by a judge that fails open, so they
   can still be missed.

For the full architecture and the reasoning behind each decision, see
[`CLAUDE.md`](./CLAUDE.md).
