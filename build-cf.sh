#!/bin/bash
# ============================================================================
# Cloudflare Pages Build Script for Waveform Viewer
# ============================================================================

set -e

# --- Configuration ---
EMSDK_DIR="$HOME/emsdk"
EMSDK_VERSION="latest"

# --- Install/Update EMSDK ---
if [ ! -d "$EMSDK_DIR" ]; then
    echo ">>> Cloning EMSDK..."
    git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
else
    echo ">>> EMSDK already exists, updating..."
    cd "$EMSDK_DIR"
    git pull
    cd -
fi

# --- Activate Emscripten ---
echo ">>> Installing and activating Emscripten $EMSDK_VERSION..."
cd "$EMSDK_DIR"
./emsdk install "$EMSDK_VERSION"
./emsdk activate "$EMSDK_VERSION"
cd -

# --- Load Environment ---
echo ">>> Loading Emscripten environment..."
source "$EMSDK_DIR/emsdk_env.sh"

# --- Run Build ---
echo ">>> Starting build process..."
make web

echo ">>> Build complete! Output is in the 'dist' directory."
