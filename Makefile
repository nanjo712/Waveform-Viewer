# ============================================================================
# Waveform Viewer - Makefile
#
# Targets:
#   make wasm       - Build WASM module via emcmake/cmake
#   make frontend   - Install deps + build React frontend (production)
#   make dev        - Start Vite dev server (development)
#   make start      - Build WASM + start dev server
#   make build      - Full production build (WASM + frontend)
#   make static     - Create a portable static build in ./dist
#   make serve      - Serve the static build in ./dist using a local server
#   make clean      - Remove all build artifacts
# ============================================================================

SHELL       := /bin/bash
EMSDK_ENV   := source ~/emsdk/emsdk_env.sh 2>/dev/null
BUILD_DIR   := build-wasm
WASM_OUT    := wasm
FRONTEND    := frontend
PUBLIC_WASM := $(FRONTEND)/public/wasm

.PHONY: all wasm frontend dev start build static serve clean help

help:
	@echo "Usage:"
	@echo "  make wasm       Build WASM module (emcmake + cmake)"
	@echo "  make frontend   Build React frontend (production)"
	@echo "  make dev        Start Vite dev server (with WASM)"
	@echo "  make start      Build WASM, then start dev server"
	@echo "  make build      Full production build (WASM + frontend)"
	@echo "  make static     Create a portable static build in ./dist"
	@echo "  make serve      Serve the static build in ./dist"
	@echo "  make clean      Remove all build artifacts"

# ── WASM build ──────────────────────────────────────────────────────

$(BUILD_DIR)/Makefile:
	@echo ">>> Configuring WASM build..."
	@$(EMSDK_ENV) && \
		mkdir -p $(BUILD_DIR) && \
		cd $(BUILD_DIR) && \
		emcmake cmake .. -DCMAKE_BUILD_TYPE=Release

wasm: $(BUILD_DIR)/Makefile
	@echo ">>> Building WASM module..."
	@$(EMSDK_ENV) && \
		cd $(BUILD_DIR) && \
		emmake make -j$$(nproc) 2>&1
	@echo ">>> Copying WASM artifacts to $(PUBLIC_WASM)/"
	@mkdir -p $(PUBLIC_WASM)
	@cp $(WASM_OUT)/vcd_parser.js  $(PUBLIC_WASM)/
	@cp $(WASM_OUT)/vcd_parser.wasm $(PUBLIC_WASM)/
	@echo ">>> WASM build complete."

# ── Frontend ────────────────────────────────────────────────────────

$(FRONTEND)/node_modules: $(FRONTEND)/package.json
	@echo ">>> Installing frontend dependencies..."
	@cd $(FRONTEND) && npm install
	@touch $@

frontend: $(FRONTEND)/node_modules wasm
	@echo ">>> Building React frontend (production)..."
	@cd $(FRONTEND) && npx vite build
	@echo ">>> Frontend build complete. Output in $(FRONTEND)/dist/"

# ── Dev server ──────────────────────────────────────────────────────

dev: $(FRONTEND)/node_modules
	@echo ">>> Starting Vite dev server on http://localhost:3000 ..."
	@cd $(FRONTEND) && npx vite --host

# ── Combined targets ────────────────────────────────────────────────

start: wasm dev

build: wasm frontend

static: build
	@echo ">>> Creating portable static package..."
	@rm -rf dist
	@cp -r $(FRONTEND)/dist dist
	@echo ">>> Static build ready in ./dist/"

serve:
	@echo ">>> Serving static build on http://localhost:8080 ..."
	@if command -v npx > /dev/null; then \
		npx serve -l 8080 dist; \
	elif command -v python3 > /dev/null; then \
		cd dist && python3 -m http.server 8080; \
	elif command -v python > /dev/null; then \
		cd dist && python -m SimpleHTTPServer 8080; \
	else \
		echo "Error: No suitable server found (npx, python3, or python)."; \
		exit 1; \
	fi

# ── Clean ───────────────────────────────────────────────────────────

clean:
	@echo ">>> Cleaning build artifacts..."
	rm -rf $(BUILD_DIR)
	rm -rf $(FRONTEND)/dist
	rm -rf dist
	rm -f  $(PUBLIC_WASM)/vcd_parser.js $(PUBLIC_WASM)/vcd_parser.wasm
	@echo ">>> Clean complete."
