#!/bin/bash
# ============================================================================
# Cloudflare Pages Build Script for Waveform Viewer
# ============================================================================

set -e

# --- Configuration ---
EMSDK_DIR="$HOME/emsdk"
EMSDK_VERSION="latest"

# --- Install CMake if missing ---
if ! command -v cmake &> /dev/null; then
    echo ">>> CMake not found. Trying to install..."
    if python3 -m pip --version &> /dev/null; then
        echo ">>> Installing cmake via python3 -m pip..."
        python3 -m pip install cmake --user
        export PATH="$HOME/.local/bin:$PATH"
    elif command -v pip &> /dev/null; then
        echo ">>> Installing cmake via pip..."
        pip install cmake --user
        export PATH="$HOME/.local/bin:$PATH"
    else
        echo ">>> Pip not found. Downloading CMake binary..."
        mkdir -p "$HOME/opt"
        # Using a stable version
        CMAKE_BIN_DIR="$HOME/opt/cmake-bin"
        mkdir -p "$CMAKE_BIN_DIR"
        curl -L https://github.com/Kitware/CMake/releases/download/v3.28.3/cmake-3.28.3-linux-x86_64.tar.gz | tar xz --strip-components=1 -C "$CMAKE_BIN_DIR"
        export PATH="$CMAKE_BIN_DIR/bin:$PATH"
    fi
fi

# Double check if cmake is now available
if ! command -v cmake &> /dev/null; then
    echo "Error: Failed to install CMake."
    exit 1
fi
echo ">>> CMake available: $(cmake --version | head -n 1)"

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
