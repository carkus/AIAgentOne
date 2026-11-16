# Running Locally

Two terminals: one for the backend (Flask), one for the frontend (Vite). A
third is optional, for the MCP server.

> **No Docker or SAM needed.** The backend runs as a plain Python Flask
> server. The SAM/Lambda path in the repo (`template.yaml`) is dev-only
> tooling and isn't how the app is deployed; see [DEPLOY.md](./DEPLOY.md).

---

## Prerequisites

| Tool | Version | Install | Verify |
| --- | --- | --- | --- |
| Python | 3.12+ | [python.org](https://www.python.org/downloads/) | `python --version` |
| Node.js | 18+ | [nodejs.org](https://nodejs.org/) | `node --version` |
| A model provider | — | see below | — |

You need at least one model provider. The backend tries them in this order
and skips any that isn't configured:

1. **Gemini**: an API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. **Cloudflare Workers AI** (hosted Qwen): an account ID and an API token
   with the "Workers AI" permission.
3. **Ollama** (local, free): [ollama.com](https://ollama.com/), then
   `ollama pull qwen3:8b` (the default model). Start the Ollama server with
   `OLLAMA_CONTEXT_LENGTH=16384`. Ollama ignores the context size the API
   asks for, so without it prompts are cut to about 2k tokens and bootstrap
   fails in odd ways.

---

## Step 1: Configure environment

Create `env.json` in the project root. `backend/server.py` reads it on
startup. The section names don't matter: every non-empty value in every
section is loaded as an environment variable, unless that variable is
already set.

```json
{
  "Backend": {
    "GEMINI_API_KEY": "your-gemini-key",
    "CLOUDFLARE_ACCOUNT_ID": "your-account-id",
    "CLOUDFLARE_API_TOKEN": "your-workers-ai-token",
    "TAVILY_API_KEY": "your-tavily-key",
    "HF_API_TOKEN": "your-huggingface-token",
    "ADZUNA_APP_ID": "your-app-id",
    "ADZUNA_APP_KEY": "your-app-key"
  }
}
```

Leave out any you don't have. Only one model provider is required. The
others turn on optional features:

- `TAVILY_API_KEY`: general web search, as a vetted MCP tool
- `HF_API_TOKEN`: image-generation fallback
- `ADZUNA_APP_*`: the job-search agent type's `search_jobs` tool

Ollama needs no key. `OLLAMA_MODEL` and `OLLAMA_BASE_URL` override its
defaults, `LLM_PROVIDER=ollama` forces it, and `DISABLE_OLLAMA=1` removes it.
See [`.env.example`](./.env.example) for every variable and
[CLAUDE.md](./CLAUDE.md) for the full cascade behaviour.

> **Keep `env.json` out of source control.** It is already listed in `.gitignore`.

Create `frontend/.env.local`:

```text
VITE_API_URL=
```

> Leave `VITE_API_URL` empty. The Vite dev server proxies the API routes
> to `localhost:4891`, so no value is needed.

---

## Step 2: Install backend dependencies

```powershell
pip install -r backend/requirements.txt
```

---

## Step 3: Install frontend dependencies

```powershell
cd frontend
npm install
cd ..
```

---

## Step 4: Start the backend (Terminal 1)

From the project root:

```powershell
python backend/server.py
```

Expected output:

```text
Starting local dev server on http://localhost:4891
 * Running on http://127.0.0.1:4891
```

Server-side data (bootstrap memory, eval history, saved profiles, published
agents) goes in `data/agentone.db`, next to `backend/`.

---

## Step 4.5: Start the MCP server (Terminal 3, optional)

Only needed to test AgentOne's own MCP-server side: published agents exposed
as MCP tools that other clients can call (see the "AgentOne as an MCP
server" section of [CLAUDE.md](./CLAUDE.md)). It's a separate process from
the Flask backend, since the `mcp` SDK's HTTP transport is ASGI, not WSGI:

```powershell
python backend/mcp_server.py
```

```text
Starting MCP server on http://localhost:4892/mcp
```

Publish an agent first: deploy one, use it, then click the **Roster**
button in the agent header and choose **Add to Roster**. Then point any MCP
client at `http://localhost:4892/mcp`.

---

## Step 5: Start the frontend (Terminal 2)

```powershell
cd frontend
npm run dev
```

Expected output:

```text
  VITE v5.x.x  ready in xxx ms

  ➜  Local:   http://localhost:5273/
```

Open [http://localhost:5273](http://localhost:5273) in your browser.

---

## Verifying It Works

1. The app loads on the **Setup** screen, with the 1–4 steps (Character,
   Focus, Brief, Outputs) above a process graph.
2. **Character:** pick an agent type (personality and behaviours are
   optional).
3. **Focus:** add one or two topics.
4. **Brief:** a drafted brief and a brief graph appear (a few seconds on
   Gemini; longer on a local model).
5. **Outputs:** the agent proposes deliverables, with its picks ticked.
6. Click **Deploy**. The graph shows bootstrap's stages (grounding, design,
   one node per tool, checks) until the agent opens.
7. The agent starts on its focus topics: tool calls and worker cards stream
   in live, then the report arrives.

If Deploy fails, check the backend terminal for the Python traceback.

---

## Making Backend Changes

The backend doesn't reload by itself. After editing `backend/server.py` or
anything in `backend/src/`, stop it (Ctrl+C) and run
`python backend/server.py` again. The same goes for `backend/mcp_server.py`.

---

## Making Frontend Changes

Vite hot-reloads automatically. Edit any file in `frontend/src/` and the
browser updates instantly.

---

## Changing the Port

The backend defaults to port `4891` (deliberately not `3000`/`5000`/`8000`,
which tend to collide with other projects' dev servers). If `4891` is also
taken, override it:

```powershell
$env:PORT=3987
python backend/server.py
```

Then change every target in the `proxy` block of `frontend/vite.config.ts`
from `http://localhost:4891` to the new port. There is one entry per API
route (`/bootstrap`, `/agent`, `/brief`, `/relic`, `/agents`, `/models`, …).

The frontend's own port, `5273`, is set in the same file with
`strictPort: true`, so Vite stops with an error instead of picking another
port if it's taken.

The MCP server (`backend/mcp_server.py`) has its own port, `4892`, which you
can override with `MCP_PORT`. It's a separate process from the Flask backend
and isn't proxied by Vite: MCP clients connect to it directly, not through
the frontend.

**Auth:** with `MCP_API_KEY` unset (the default locally), `/mcp` is open.
Set it to require every request to send a matching `X-Api-Key` header (or
`?key=` query parameter). See DEPLOY.md for production.

---

## Troubleshooting

**`ModuleNotFoundError: No module named 'openai'` (or `flask`, `requests`)**

The Python packages aren't installed in your local environment. Run:

```powershell
pip install -r backend/requirements.txt
```

---

**`Bootstrap failed` or a request returns an error immediately**

Open browser DevTools → Network tab and check the `/bootstrap` request:

- `net::ERR_CONNECTION_REFUSED` or a Vite proxy error: the backend isn't
  running. Start it with `python backend/server.py`.
- `500` response: check the backend terminal for the Python traceback.

---

**Browser console shows a CORS error**

The Flask server handles CORS directly, so this should not occur. If it
does, confirm `frontend/.env.local` has `VITE_API_URL=` (empty, not
`http://localhost:4891`) and restart the Vite dev server.

---

**Bootstrap returns `Unterminated string` / JSON parse error**

The model's reply was cut off before it finished the JSON. On Ollama, the
usual cause is the 2k-token context: restart the Ollama server with
`OLLAMA_CONTEXT_LENGTH=16384`. Otherwise `max_tokens` in `bootstrap.py` is
`16000`, which should be enough; if it recurs, try fewer focus topics.

---

**Only Ollama is offered, or a cloud provider is missing from Settings**

A provider appears only when its credentials load. Check that the key is
spelled correctly and isn't empty in `env.json`. Also check that you
started `python backend/server.py` from the project root (the folder that
contains `backend/` and `frontend/`), since that's where it looks for
`env.json`.

---

## Deploying

Production runs on a systemd + nginx droplet, shipped with
`deploy/redeploy.sh`. See [DEPLOY.md](./DEPLOY.md).
