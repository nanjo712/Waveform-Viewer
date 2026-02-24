# ============================================================================
# Waveform Viewer - Makefile
# ============================================================================

SHELL       := /bin/bash
EMSDK_ENV   := source ~/emsdk/emsdk_env.sh 2>/dev/null || true
BUILD_DIR   := build-wasm
FRONTEND    := frontend
WASM_OUT    := wasm
PUBLIC_WASM := $(FRONTEND)/public/wasm

# Environment Helpers
WASM_RUN    := $(EMSDK_ENV) && mkdir -p $(BUILD_DIR) && cd $(BUILD_DIR)
FE_RUN      := cd $(FRONTEND)
NPROC       := $(shell nproc 2>/dev/null || echo 1)

ifeq ($(OS),Windows_NT)
    EMCMAKE := emcmake.bat
    EMMAKE  := emmake.bat
else
    EMCMAKE := emcmake
    EMMAKE  := emmake
endif

.PHONY: all wasm native frontend dev start build static serve clean help

help:
	@echo "Usage:"
	@echo "  make wasm       Build WASM module"
	@echo "  make native     Build native CLI (vcd_viewer)"
	@echo "  make frontend   Build React frontend"
	@echo "  make dev        Start Vite dev server (on port 3000)"
	@echo "  make start      Alias for 'make wasm dev'"
	@echo "  make build      Build both WASM and Frontend"
	@echo "  make static     Create portable build in ./dist"
	@echo "  make serve      Serve static build from ./dist"
	@echo "  make clean      Remove build artifacts"

# ── WASM build ──────────────────────────────────────────────────────

$(BUILD_DIR)/Makefile:
	@echo ">>> Configuring WASM build..."
	@$(WASM_RUN) && $(EMCMAKE) cmake .. -DCMAKE_BUILD_TYPE=Release

wasm: $(BUILD_DIR)/Makefile
	@echo ">>> Building WASM module..."
	@$(WASM_RUN) && $(EMMAKE) make -j$(NPROC)
	@echo ">>> Copying WASM artifacts to $(PUBLIC_WASM)/"
	@mkdir -p $(PUBLIC_WASM)
	@cp $(WASM_OUT)/vcd_parser.{js,wasm} $(PUBLIC_WASM)/

# ── Native build ────────────────────────────────────────────────────

native:
	@echo ">>> Building Native CLI..."
	@mkdir -p build-native
	@cd build-native && cmake .. -DCMAKE_BUILD_TYPE=Release && make -j$(NPROC)


# ── Frontend ────────────────────────────────────────────────────────

$(FRONTEND)/node_modules: $(FRONTEND)/package.json
	@echo ">>> Installing dependencies..."
	@$(FE_RUN) && npm install
	@touch $@

frontend: $(FRONTEND)/node_modules wasm
	@echo ">>> Building Production Frontend..."
	@$(FE_RUN) && npx vite build

dev: $(FRONTEND)/node_modules wasm
	@echo ">>> Starting Dev Server..."
	@$(FE_RUN) && npx vite --host

# ── Composite Targets ───────────────────────────────────────────────

start: dev

build: frontend

static: build
	@echo ">>> Creating static package..."
	@rm -rf dist && cp -r $(FRONTEND)/dist dist

serve:
	@echo ">>> Serving static build on http://localhost:8080 ..."
	@if npx serve -v >/dev/null 2>&1; then \
		npx serve -l 8080 dist; \
	elif python3 -m http.server --help >/dev/null 2>&1; then \
		cd dist && python3 -m http.server 8080; \
	else \
		echo "Error: npx or python3 required."; exit 1; \
	fi

clean:
	@echo ">>> Cleaning..."
	@rm -rf $(BUILD_DIR) build-native $(FRONTEND)/dist dist
	@rm -f $(PUBLIC_WASM)/vcd_parser.{js,wasm}
