# ─────────────────────────────────────────────────────────────────────────────
# a2a-langchain-mcp  –  Podman + kind deployment
# ─────────────────────────────────────────────────────────────────────────────
#
# Prerequisites:
#   brew install podman kind kubectl
#   podman machine init && podman machine start   # macOS only
#   ollama serve                                  # Ollama runs on the host
#   ollama pull qwen3:4b
#
# Quick start:
#   make all
#
# ─────────────────────────────────────────────────────────────────────────────

CLUSTER_NAME   := a2a-cluster
KIND_CONFIG    := k8s/kind-config.yaml
NAMESPACE      := a2a-system
IMAGES := mcp-server a2a-server
# Podman is used as the container engine; tell kind to use it.
export KIND_EXPERIMENTAL_PROVIDER := podman

.PHONY: all build cluster-create load deploy wait delete clean help logs-mcp logs-a2a logs-ui status

# ── Top-level targets ─────────────────────────────────────────────────────────

## all: Build images, create cluster, load images, deploy everything
all: build cluster-create load deploy
	@echo ""
	@echo "✅  Deployment complete. Access points:"
	@echo "    A2A Server → http://localhost:4000"
	@echo "    A2A gRPC   → localhost:4001"
	@echo "    MCP Server → http://localhost:5000"
	@echo "    Ollama     → http://localhost:11434  (host machine)"

## build: Build all container images with Podman
build:
	@echo "── Building mcp-server ──────────────────────────────────────────────────────"
	podman build -t mcp-server:latest apps/mcp-server
	@echo "── Building a2a-server ──────────────────────────────────────────────────────"
	podman build -t a2a-server:latest apps/a2a-server

## cluster-create: Create the kind cluster (idempotent – skips if already exists)
cluster-create:
	@if kind get clusters 2>/dev/null | grep -q "^$(CLUSTER_NAME)$$"; then \
		echo "ℹ️  Cluster '$(CLUSTER_NAME)' already exists – skipping creation."; \
	else \
		echo "── Creating kind cluster '$(CLUSTER_NAME)' ────────────────────────────────────"; \
		kind create cluster --config $(KIND_CONFIG); \
	fi

## load: Load locally-built images into the kind cluster
load:
	@echo "── Loading images into kind cluster ─────────────────────────────────────────"
	@for img in $(IMAGES); do \
		echo "  Loading $$img:latest"; \
		podman save $$img:latest | kind load image-archive /dev/stdin \
			--name $(CLUSTER_NAME); \
	done

## deploy: Apply all Kubernetes manifests
deploy:
	@echo "── Applying Kubernetes manifests ────────────────────────────────────────────"
	kubectl apply -f k8s/namespace.yaml
	kubectl apply -f k8s/redis/
	kubectl apply -f k8s/mcp-server/
	kubectl apply -f k8s/a2a-server/
	@echo "── Waiting for rollout ───────────────────────────────────────────────────────"
	kubectl rollout status deployment/redis      -n $(NAMESPACE) --timeout=60s
	kubectl rollout status deployment/mcp-server -n $(NAMESPACE) --timeout=120s
	kubectl rollout status deployment/a2a-server -n $(NAMESPACE) --timeout=120s

## delete: Tear down all deployed resources (keeps the cluster)
delete:
	@echo "── Deleting namespace $(NAMESPACE) ──────────────────────────────────────────"
	kubectl delete namespace $(NAMESPACE) --ignore-not-found

## clean: Delete the kind cluster and all associated resources
clean:
	@echo "── Deleting kind cluster '$(CLUSTER_NAME)' ──────────────────────────────────"
	kind delete cluster --name $(CLUSTER_NAME)

# ── Utilities ─────────────────────────────────────────────────────────────────

## logs-mcp: Tail mcp-server logs
logs-mcp:
	kubectl logs -f deployment/mcp-server -n $(NAMESPACE)

## logs-a2a: Tail a2a-server logs
logs-a2a:
	kubectl logs -f deployment/a2a-server -n $(NAMESPACE)

## status: Show pod status
status:
	kubectl get pods -n $(NAMESPACE)

## help: Show this help message
help:
	@grep -E '^## ' Makefile | sed 's/## //'
