# ============================================================================
# Waveform Viewer - Makefile
# ============================================================================

SHELL       := /bin/bash
EMSDK_ENV   := source ~/emsdk/emsdk_env.sh 2>/dev/null || true
BUILD_DIR   := build-wasm
FRONTEND    := frontend
WASM_OUT    := wasm
# Per-app public directories for WASM files
PUBLIC_WASM_WEB    := $(FRONTEND)/packages/app-web/public/wasm
PUBLIC_WASM_TAURI  := $(FRONTEND)/packages/app-tauri/public/wasm
PUBLIC_WASM_VSCODE := $(FRONTEND)/packages/app-vscode/media/wasm

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

.PHONY: all wasm native frontend dev start build static serve clean help \
       vscode vscode-watch vscode-launch vscode-test

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
	@echo "  make vscode     Build VSCode extension"
	@echo "  make vscode-watch  Watch mode for VSCode extension"
	@echo "  make vscode-launch Build & open Extension Dev Host with test file"
	@echo "  make vscode-test   Build & open Extension Dev Host (no file)"
	@echo "  make clean      Remove build artifacts"

# ── WASM build ──────────────────────────────────────────────────────

$(BUILD_DIR)/Makefile:
	@echo ">>> Configuring WASM build..."
	@$(WASM_RUN) && $(EMCMAKE) cmake .. -DCMAKE_BUILD_TYPE=Release

wasm: $(BUILD_DIR)/Makefile
	@echo ">>> Building WASM module..."
	@$(WASM_RUN) && $(EMMAKE) make -j$(NPROC)
	@echo ">>> Copying WASM artifacts to app packages..."
	@mkdir -p $(PUBLIC_WASM_WEB) $(PUBLIC_WASM_TAURI) $(PUBLIC_WASM_VSCODE)
	@cp $(WASM_OUT)/vcd_parser.{js,wasm} $(PUBLIC_WASM_WEB)/
	@cp $(WASM_OUT)/vcd_parser.{js,wasm} $(PUBLIC_WASM_TAURI)/
	@cp $(WASM_OUT)/vcd_parser.{js,wasm} $(PUBLIC_WASM_VSCODE)/

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
	@$(FE_RUN) && npm run build

dev: $(FRONTEND)/node_modules wasm
	@echo ">>> Starting Dev Server..."
	@$(FE_RUN) && npm run dev

# ── VSCode Extension ───────────────────────────────────────────────

VSCODE_PKG  := $(FRONTEND)/packages/app-vscode

vscode: $(FRONTEND)/node_modules wasm
	@echo ">>> Building VSCode extension..."
	@$(FE_RUN) && npm run build:vscode

vscode-watch: $(FRONTEND)/node_modules wasm
	@echo ">>> Starting VSCode extension watch mode..."
	@$(FE_RUN) && cd packages/app-vscode && node esbuild.mjs --watch

vscode-launch: vscode
	@echo ">>> Launching Extension Development Host..."
	@code --extensionDevelopmentPath=$(CURDIR)/$(VSCODE_PKG) \
		$(CURDIR)/tests/test_multibit.vcd

vscode-test: vscode
	@echo ">>> Launching Extension Development Host (no file)..."
	@code --extensionDevelopmentPath=$(CURDIR)/$(VSCODE_PKG)

# ── Composite Targets ───────────────────────────────────────────────

start: dev

build: frontend

static: build
	@echo ">>> Creating static package..."
	@rm -rf dist && cp -r $(FRONTEND)/packages/app-web/dist dist

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
	@rm -rf $(BUILD_DIR) build-native $(FRONTEND)/packages/app-web/dist $(FRONTEND)/packages/app-tauri/dist $(FRONTEND)/packages/app-vscode/dist dist
	@rm -f $(PUBLIC_WASM_WEB)/vcd_parser.{js,wasm}
	@rm -f $(PUBLIC_WASM_TAURI)/vcd_parser.{js,wasm}
	@rm -f $(PUBLIC_WASM_VSCODE)/vcd_parser.{js,wasm}
