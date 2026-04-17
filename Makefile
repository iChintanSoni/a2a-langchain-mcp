# ─────────────────────────────────────────────────────────────────────────────
# a2a-langchain-mcp  –  Podman + kind deployment
# ─────────────────────────────────────────────────────────────────────────────
#
# Prerequisites:
#   brew install podman kind kubectl
#   podman machine init && podman machine start   # macOS only
#   ollama serve                                  # Ollama runs on the host
#   ollama pull qwen3:4b
#   ollama pull x/flux2-klein:4b
#   export TAVILY_API_KEY=...                     # For mcp-server web search
#
# Common commands:
#   make mcp       # Run only mcp-server
#   make a2a       # Run only a2a-server + redis
#   make apps      # Run mcp-server + a2a-server + redis
#   make docling   # Run only docling-serve
#   make all       # Run apps + docling
#
# Images are pulled only when they are missing locally.
# ─────────────────────────────────────────────────────────────────────────────

CLUSTER_NAME := a2a-cluster
KIND_CONFIG := k8s/kind-config.yaml
NAMESPACE := a2a-system

NODE_IMAGE := docker.io/library/node:24-slim
REDIS_IMAGE := docker.io/redis/redis-stack-server:7.4.0-v8
DOCLING_IMAGE := quay.io/docling-project/docling-serve-cpu:latest

IMAGE_TAG ?= $(shell git rev-parse --short=12 HEAD 2>/dev/null || echo local)-$(shell date -u +%Y%m%d%H%M%S)

MCP_IMAGE_REPO := mcp-server
A2A_IMAGE_REPO := a2a-server
MCP_IMAGE := $(MCP_IMAGE_REPO):$(IMAGE_TAG)
A2A_IMAGE := $(A2A_IMAGE_REPO):$(IMAGE_TAG)
MCP_K8S_IMAGE := localhost/$(MCP_IMAGE)
A2A_K8S_IMAGE := localhost/$(A2A_IMAGE)

MCP_ENV_FILE := apps/mcp-server/.env
PODMAN_BUILD_FLAGS ?= --pull=never
IMAGE_RETAIN ?= 5

# Podman is used as the container engine; tell kind to use it.
export KIND_EXPERIMENTAL_PROVIDER := podman

-include $(MCP_ENV_FILE)

.PHONY: all apps mcp a2a docling clean-images clean-app-images delete clean help logs-mcp logs-a2a logs-docling status machine-reset machine-status
.PHONY: cluster namespace ensure-node ensure-redis ensure-docling build-mcp build-a2a load-mcp load-a2a load-redis load-docling
.PHONY: deploy-mcp deploy-a2a deploy-redis deploy-docling secret-mcp wait-mcp wait-a2a wait-redis wait-docling endpoints-apps endpoints-mcp endpoints-a2a endpoints-docling

define ensure_image
	@if podman image exists $(1); then \
		echo "Using cached $(1)"; \
	else \
		echo "Pulling missing $(1)"; \
		podman pull $(1); \
	fi
endef

## all: Run apps and docling
all: apps docling

## apps: Run mcp-server, a2a-server, and redis
apps: cluster namespace build-mcp build-a2a load-redis load-mcp load-a2a deploy-redis deploy-mcp deploy-a2a wait-redis wait-mcp wait-a2a endpoints-apps

## mcp: Run only mcp-server
mcp: cluster namespace build-mcp load-mcp deploy-mcp wait-mcp endpoints-mcp

## a2a: Run only a2a-server and redis
a2a: cluster namespace build-a2a load-redis load-a2a deploy-redis deploy-a2a wait-redis wait-a2a endpoints-a2a

## docling: Run only docling-serve
docling: cluster namespace load-docling deploy-docling wait-docling endpoints-docling

cluster:
	@if kind get clusters 2>/dev/null | grep -q "^$(CLUSTER_NAME)$$"; then \
		echo "Using existing kind cluster '$(CLUSTER_NAME)'"; \
	else \
		echo "Creating kind cluster '$(CLUSTER_NAME)'"; \
		kind create cluster --config $(KIND_CONFIG); \
	fi

namespace:
	kubectl apply -f k8s/namespace.yaml

ensure-node:
	$(call ensure_image,$(NODE_IMAGE))

ensure-redis:
	$(call ensure_image,$(REDIS_IMAGE))

ensure-docling:
	$(call ensure_image,$(DOCLING_IMAGE))

build-mcp: ensure-node
	podman build $(PODMAN_BUILD_FLAGS) -t $(MCP_IMAGE) -f apps/mcp-server/Containerfile .

build-a2a: ensure-node
	podman build $(PODMAN_BUILD_FLAGS) -t $(A2A_IMAGE) -f apps/a2a-server/Containerfile .

load-mcp:
	podman save $(MCP_IMAGE) | kind load image-archive /dev/stdin --name $(CLUSTER_NAME)

load-a2a:
	podman save $(A2A_IMAGE) | kind load image-archive /dev/stdin --name $(CLUSTER_NAME)

load-redis: ensure-redis
	podman save $(REDIS_IMAGE) | kind load image-archive /dev/stdin --name $(CLUSTER_NAME)

load-docling: ensure-docling
	podman save $(DOCLING_IMAGE) | kind load image-archive /dev/stdin --name $(CLUSTER_NAME)

deploy-redis:
	kubectl apply -f k8s/redis/

deploy-mcp: secret-mcp
	kubectl apply -f k8s/mcp-server/configmap.yaml
	kubectl apply -f k8s/mcp-server/service.yaml
	kubectl set image --local -f k8s/mcp-server/deployment.yaml mcp-server=$(MCP_K8S_IMAGE) -o yaml | kubectl apply -f -

deploy-a2a:
	kubectl apply -f k8s/a2a-server/configmap.yaml
	kubectl apply -f k8s/a2a-server/service.yaml
	kubectl set image --local -f k8s/a2a-server/deployment.yaml a2a-server=$(A2A_K8S_IMAGE) -o yaml | kubectl apply -f -

deploy-docling:
	kubectl apply -f k8s/docling-serve/

secret-mcp:
	@test -n "$(strip $(TAVILY_API_KEY))" || (echo "$(MCP_ENV_FILE) must define TAVILY_API_KEY."; exit 1)
	kubectl create secret generic mcp-server-secret \
		--namespace $(NAMESPACE) \
		--from-literal=TAVILY_API_KEY="$(TAVILY_API_KEY)" \
		--dry-run=client -o yaml | kubectl apply -f -

wait-redis:
	kubectl rollout status deployment/redis -n $(NAMESPACE) --timeout=60s

wait-mcp:
	kubectl rollout status deployment/mcp-server -n $(NAMESPACE) --timeout=300s

wait-a2a:
	kubectl rollout status deployment/a2a-server -n $(NAMESPACE) --timeout=300s

wait-docling:
	kubectl rollout status deployment/docling-serve -n $(NAMESPACE) --timeout=600s

endpoints-apps:
	@echo ""
	@echo "Deployment complete:"
	@echo "  MCP Server    -> http://localhost:5050"
	@echo "  A2A Server    -> http://localhost:4000"
	@echo "  A2A gRPC      -> localhost:4001"
	@echo "  Ollama        -> http://localhost:11434"

endpoints-mcp:
	@echo ""
	@echo "MCP Server -> http://localhost:5050"

endpoints-a2a:
	@echo ""
	@echo "A2A Server -> http://localhost:4000"
	@echo "A2A gRPC   -> localhost:4001"

endpoints-docling:
	@echo ""
	@echo "Docling Serve -> http://localhost:30004"

## clean-images: Remove dangling Podman images and build cache
clean-images:
	podman image prune -f
	podman builder prune -f || true

## clean-app-images: Keep the newest app image tags and remove older local builds
clean-app-images:
	@for repo in $(MCP_IMAGE_REPO) $(A2A_IMAGE_REPO); do \
		echo "Pruning $$repo images, keeping newest $(IMAGE_RETAIN)"; \
		podman images "$$repo" --format "{{.Tag}} {{.Repository}}:{{.Tag}}" | \
			awk '{ tag = $$1; ts = substr(tag, length(tag) - 13); if (length(ts) == 14 && ts ~ /^[0-9]+$$/) print ts, $$2 }' | \
			sort -r | \
			awk 'NR > retain { print $$2 }' retain="$(IMAGE_RETAIN)" | \
			xargs -r podman rmi || true; \
	done

## delete: Delete deployed Kubernetes resources but keep the cluster
delete:
	kubectl delete namespace $(NAMESPACE) --ignore-not-found

## clean: Delete the kind cluster
clean:
	kind delete cluster --name $(CLUSTER_NAME)

## logs-mcp: Tail mcp-server logs
logs-mcp:
	kubectl logs -f deployment/mcp-server -n $(NAMESPACE)

## logs-a2a: Tail a2a-server logs
logs-a2a:
	kubectl logs -f deployment/a2a-server -n $(NAMESPACE)

## logs-docling: Tail docling-serve logs
logs-docling:
	kubectl logs -f deployment/docling-serve -n $(NAMESPACE)

## status: Show pod status
status:
	kubectl get pods -n $(NAMESPACE)

## machine-reset: Delete and recreate the podman machine
machine-reset:
	podman machine stop || true
	podman machine rm -f || true
	podman machine init --cpus 4 --memory 4096 --disk-size 50
	podman machine start

## machine-status: Inspect the podman machine resources
machine-status:
	podman machine inspect

## help: Show this help message
help:
	@grep -E '^## ' Makefile | sed 's/## //'
