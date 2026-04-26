PYTHON ?= python3
VENV_DIR ?= .venv
VENV_PYTHON := $(VENV_DIR)/bin/python
PIP := $(VENV_PYTHON) -m pip

REPO ?= .
QUESTION ?= Where is the OpenAI model interface implemented?
TOP_K ?= 6
MODEL ?= gpt-4o-mini
OUTPUT ?= result.json
PORT ?= 8000
HOST ?= 127.0.0.1
IMAGE_NAME ?= ghost-test-catcher
WORKSPACE_PYTHON ?= /Users/carlhyllen/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3

.PHONY: help venv install install-dev explain explain-self web serve docker-build docker-run clean

help:
	@echo "Available targets:"
	@echo "  make venv            Create a local virtual environment in $(VENV_DIR)"
	@echo "  make install         Install CLI and web app dependencies"
	@echo "  make install-dev     Install development dependencies too"
	@echo "  make explain         Run the codebase RAG explainer"
	@echo "  make explain-self    Run the acceptance example against this repo"
	@echo "  make web             Start the Ghost Test Catcher web app"
	@echo "  make serve           Serve the repo statically on http://localhost:$(PORT)"
	@echo "  make docker-build    Build the Docker image"
	@echo "  make docker-run      Run the Dockerized web app on http://localhost:$(PORT)"
	@echo "  make clean           Remove build artifacts and caches"
	@echo ""
	@echo "Runtime variables:"
	@echo "  REPO=/path/to/repo"
	@echo "  QUESTION='Where is authentication handled?'"
	@echo "  TOP_K=6 MODEL=gpt-4o-mini OUTPUT=result.json PORT=8000 HOST=127.0.0.1"
	@echo "  PYTHON=/path/to/python3.11"
	@echo ""
	@echo "Example:"
	@echo "  make install PYTHON=$(WORKSPACE_PYTHON)"
	@echo "  make web PYTHON=$(WORKSPACE_PYTHON)"
	@echo "  OPENAI_API_KEY=... make explain QUESTION='Where is authentication handled?' REPO=/path/to/repo"

venv:
	@$(PYTHON) -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else "Python 3.11+ is required. Pass PYTHON=/path/to/python3.11")'
	@test -d "$(VENV_DIR)" || $(PYTHON) -m venv "$(VENV_DIR)"

install: venv
	$(PIP) install --upgrade pip
	$(PIP) install -e ".[codebase,webapp]"

install-dev: venv
	$(PIP) install --upgrade pip
	$(PIP) install -e ".[codebase,webapp,dev]"

explain:
	@test -x "$(VENV_PYTHON)" || (echo "Virtualenv missing. Run 'make install' first." && exit 1)
	$(VENV_PYTHON) tools/codebase_rag_explain.py \
		--repo "$(REPO)" \
		--question "$(QUESTION)" \
		--top-k "$(TOP_K)" \
		--model "$(MODEL)" \
		--output "$(OUTPUT)"

explain-self: REPO=.
explain-self: QUESTION=Where is the OpenAI model interface implemented?
explain-self:
	$(MAKE) explain REPO="$(REPO)" QUESTION="$(QUESTION)" TOP_K="$(TOP_K)" MODEL="$(MODEL)" OUTPUT="$(OUTPUT)"

web:
	@test -x "$(VENV_PYTHON)" || (echo "Virtualenv missing. Run 'make install' first." && exit 1)
	$(VENV_PYTHON) -m uvicorn llmSHAP.webapp.app:app --host "$(HOST)" --port "$(PORT)"

serve:
	@echo "Serving /Users/carlhyllen/Documents/Hackathon/Project/llmSHAP on http://localhost:$(PORT)"
	$(PYTHON) -m http.server "$(PORT)"

docker-build:
	docker build -t "$(IMAGE_NAME)" .

docker-run:
	docker run --rm -p "$(PORT):8000" "$(IMAGE_NAME)"

clean:
	rm -rf "$(VENV_DIR)" .pytest_cache result.json
	find . -type d -name "__pycache__" -prune -exec rm -rf {} +
