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

.PHONY: all wasm native web tauri vsix dev clean help \
       vscode release

release:
	@if [ -z "$(V)" ]; then echo "Error: V is not set. Use: make release V=0.x.y"; exit 1; fi
	@echo ">>> Bumping version to v$(V)..."
	@# Update Frontend packages
	@sed -i '0,/"version": "[^"]*"/s//"version": "$(V)"/' frontend/package.json
	@find frontend/packages -name package.json -maxdepth 2 -exec sed -i '0,/"version": "[^"]*"/s//"version": "$(V)"/' {} +
	@# Update Tauri configuration
	@sed -i '0,/"version": "[^"]*"/s//"version": "$(V)"/' src-tauri/tauri.conf.json
	@sed -i '0,/^version = "[^"]*"/s//version = "$(V)"/' src-tauri/Cargo.toml
	@# Sync lock files
	@echo ">>> Updating lock files..."
	@cd $(FRONTEND) && npm install
	@cd src-tauri && cargo fetch
	@# Git operations
	@echo ">>> Committing and tagging..."
	@git add .
	@git commit -m "chore: bump version to v$(V)"
	@git tag v$(V)
	@echo ">>> Pushing to origin..."
	@git push origin main
	@git push origin v$(V)

help:
	@echo "Usage:"
	@echo "  make wasm       Build WASM module"
	@echo "  make native     Build native CLI (vcd_viewer)"
	@echo "  make web        Build React web app and create static package"
	@echo "  make tauri      Build Tauri desktop application"
	@echo "  make dev        Start Vite dev server (on port 3000)"
	@echo "  make vscode     Build VSCode extension package"
	@echo "  make vsix       Package VSCode extension (.vsix)"
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

web: $(FRONTEND)/node_modules wasm
	@echo ">>> Building Production Web App..."
	@$(FE_RUN) && npm run build
	@echo ">>> Creating web package..."
	@rm -rf dist && cp -r $(FRONTEND)/packages/app-web/dist dist

tauri: $(FRONTEND)/node_modules wasm
	@echo ">>> Building Tauri application..."
	@$(FE_RUN) && npm run build:tauri
	@cd $(FRONTEND)/packages/app-tauri && npx @tauri-apps/cli build

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

vsix: vscode
	@echo ">>> Packaging VSCode extension..."
	@sed -i 's/"name": "@waveform-viewer\/app-vscode"/"name": "waveform-viewer"/' $(FRONTEND)/packages/app-vscode/package.json
	@$(FE_RUN) && cd packages/app-vscode && npm run package
	@sed -i 's/"name": "waveform-viewer"/"name": "@waveform-viewer\/app-vscode"/' $(FRONTEND)/packages/app-vscode/package.json

clean:
	@echo ">>> Cleaning..."
	@rm -rf $(BUILD_DIR) build-native $(FRONTEND)/packages/app-web/dist $(FRONTEND)/packages/app-tauri/dist $(FRONTEND)/packages/app-vscode/dist dist
	@rm -f $(PUBLIC_WASM_WEB)/vcd_parser.{js,wasm}
	@rm -f $(PUBLIC_WASM_TAURI)/vcd_parser.{js,wasm}
	@rm -f $(PUBLIC_WASM_VSCODE)/vcd_parser.{js,wasm}
