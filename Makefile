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
WORKSPACE_PYTHON ?= $(PYTHON)
TESTS ?= tests/test_webapp_execution.py
SOURCE ?= src

.PHONY: help venv install install-dev audit quality ghost ghost-ci calibrate extension-icon extension-check extension-package explain explain-self web serve docker-build docker-run clean

help:
	@echo "Available targets:"
	@echo "  make venv            Create a local virtual environment in $(VENV_DIR)"
	@echo "  make install         Install CLI and web app dependencies"
	@echo "  make install-dev     Install development dependencies too"
	@echo "  make audit           Run repository hygiene checks"
	@echo "  make quality         Run hygiene, Python tests, and extension unit checks"
	@echo "  make ghost           Analyze pytest files with Ghost Test Catcher"
	@echo "  make ghost-ci        Run the Ghost Test Catcher CI gate"
	@echo "  make calibrate       Run Ghost Test Catcher calibration cases"
	@echo "  make extension-icon  Regenerate the VS Code extension icon"
	@echo "  make extension-check Check and package the VS Code extension"
	@echo "  make extension-package Build the local VSIX extension package"
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
	@echo "  TESTS=tests/test_file.py SOURCE=src"
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

audit:
	$(PYTHON) tools/repo_hygiene_audit.py

quality: audit
	$(PYTHON) -m pytest
	cd packages/vscode-extension && npm run check && npm test

ghost:
	@test -x "$(VENV_PYTHON)" || (echo "Virtualenv missing. Run 'make install' first." && exit 1)
	$(VENV_PYTHON) -m llmSHAP.ghost.cli analyze \
		--repo "." \
		--tests "$(TESTS)" \
		--source "$(SOURCE)" \
		--format pretty

ghost-ci:
	@test -x "$(VENV_PYTHON)" || (echo "Virtualenv missing. Run 'make install' first." && exit 1)
	$(VENV_PYTHON) -m llmSHAP.ghost.cli ci \
		--repo "." \
		--tests "$(TESTS)" \
		--source "$(SOURCE)" \
		--summary ghost-test-catcher-summary.md \
		--output ghost-test-catcher-report.json \
		--format json \
		--fail-on ghost_risk

calibrate:
	@test -x "$(VENV_PYTHON)" || (echo "Virtualenv missing. Run 'make install' first." && exit 1)
	$(VENV_PYTHON) -m llmSHAP.ghost.cli calibrate --format pretty

extension-icon:
	$(PYTHON) tools/generate_vscode_extension_icon.py

extension-check:
	cd packages/vscode-extension && npm install --ignore-scripts && npm run check && npm test && npm run package

extension-package:
	cd packages/vscode-extension && npm run package

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
	@echo "Serving $(CURDIR) on http://localhost:$(PORT)"
	$(PYTHON) -m http.server "$(PORT)"

docker-build:
	docker build -t "$(IMAGE_NAME)" .

docker-run:
	docker run --rm -p "$(PORT):8000" "$(IMAGE_NAME)"

clean:
	rm -rf "$(VENV_DIR)" .pytest_cache result.json ghost-test-catcher-summary.md ghost-test-catcher-report.json
	find . -type d -name "__pycache__" -prune -exec rm -rf {} +
