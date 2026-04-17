# A2A Langchain MCP

This repository bridges Langchain's powerful graph-based agent architecture with the A2A SDK and the Model Context Protocol (MCP) to provide an end-to-end, locally-executable Personal Assistant.

## Architecture Architecture

There are two primary applications inside this monorepo:
1. **`a2a-server`**: Connects to the A2A Protocol via REST and gRPC, and coordinates the Langgraph `AgentExecutor` to fulfill tasks. 
2. **`mcp-server`**: Operates the external suite of runtime tools (`web_search`, `read_url`, `get_datetime`) and instructional context that the Langchain agent calls upon via MCP paradigms.

---

## 🚀 Running Locally (Kubernetes via Kind)

The primary and recommended way to orchestrate the infrastructure locally is using `podman` and Kubernetes (`kind`). This ensures Redis, the MCP Server, and the A2A routing server run in isolation.

### Prerequisites

You must have the following installed on your machine:
- `podman`, `kind`, and `kubectl` (Recommended: `brew install podman kind kubectl`)
- `ollama` (Running locally on your host OS)

Before spinning up the cluster, ensure your local Ollama environment is active and equipped with the required agent framework LLM:

```bash
# Start your podman machine (macOS only)
podman machine init
podman machine start

# Prepare the local LLM
ollama serve
ollama pull qwen3:4b
```

### Quick Start

We supply a `Makefile` that handles container building, cluster creation, image shipping, and pod orchestration automatically:

```bash
make all
```

Once deployment completes, the services are surfaced over the following endpoints:
- **A2A Server**: `http://localhost:4000`
- **A2A gRPC**: `localhost:4001`
- **MCP Server**: `http://localhost:5050`
- **Ollama Engine**: `http://localhost:11434`

### Helpful Commands

- **`make logs-a2a`**: Tails the running logs of your A2A Protocol server.
- **`make logs-mcp`**: Tails the running logs of your MCP framework server.
- **`make clean`**: Completely obliterates the `kind` cluster and all resources.

---

## 💻 Running Locally (Native Node.js)

If you intend to develop without building unverified container images to Kubernetes, you can run the applications natively using Node.js.

> [!NOTE]
> Since `a2a-server` uses Native Node Transform Types (`--experimental-transform-types`), ensure your Node.js runtime is configured to **Latest Node v22+** or **Node v23+**. You will also need to spin up an ephemeral Redis instance for session state via docker/podman:
> `podman run -d -p 6379:6379 redis/redis-stack-server:7.4.0-v8`

Run the MCP Server:
```bash
cd apps/mcp-server
npm install
npm run dev
```

In a new terminal window, run the A2A Agent Server:
```bash
cd apps/a2a-server
npm install
cp .env.example .env
npm run dev
```
