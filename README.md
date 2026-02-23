# <img src="assets/logo.png" width="40" height="40" align="center" style="border-radius: 8px;" /> Waveform Viewer

**English** | [中文](README_ZH.md)

Waveform Viewer is a high-performance web-based waveform viewer. The core parser is written in C++ and runs in the browser via WebAssembly.

## Usage

### 1. Online Use (GitHub Pages)

You can access the online version hosted on GitHub Pages directly without installing any software:

👉 **[Access Waveform Viewer Online](https://nanjo712.github.io/Waveform-Viewer/)**

### 2. Pre-built Binaries (Releases)

If you wish to run it independently or use the desktop version (powered by Tauri), you can obtain pre-built binaries from the GitHub Releases page.

1. Visit the [Releases Page](https://github.com/nanjo712/Waveform-Viewer/releases).
2. Download the package or installer for your operating system (Windows, macOS, Linux).
3. Extract and run it.

### 3. Self-Build (Fork & Build)

If you want to do secondary development or build it yourself, please follow these steps:

#### Prerequisites

- **Node.js** (v20+ recommended)
- **Emscripten** (for compiling C++ to WASM)
- **Make** (build tool)
- **Rust/Tauri** (optional, required only for building the desktop version)

#### Build Steps

1. **Fork and Clone the Repository**:
   ```bash
   git clone https://github.com/nanjo712/Waveform-Viewer.git
   cd Waveform-Viewer
   ```

2. **Compile WASM Core**:
   ```bash
   make wasm
   ```

3. **Build Frontend**:
   ```bash
   make frontend
   ```

4. **Generate Static Build**:
   ```bash
   make static
   ```
   After the build is complete, all artifacts will be stored in the `./dist` directory.

5. **Local Development Preview**:
   ```bash
   make dev
   ```
   Then open `http://localhost:3000` in your browser.

---

## Plugin Development Guide

> [!NOTE]
> **Can I write plugins in WASM or native C++?**
> Currently, the Waveform Viewer core parser is written in C++ and compiled to WebAssembly (WASM) for high performance. However, **all formatting plugins must be written in JavaScript or TypeScript**. The plugin system relies on the browser's JavaScript engine to execute the `format` functions and dynamically inject them into the React frontend. If you have computationally heavy formatting logic, you could technically compile it to a separate WASM module and call it from your JavaScript plugin wrapper, but the plugin interface itself must remain in JS/TS.

This document explains how to write and register custom signal formatting plugins for the Waveform Viewer.

#### Overview

The Waveform Viewer supports custom formatters to display signal values in different ways (e.g., Hexadecimal, Float, ASCII, etc.). A plugin can define multiple "views" (formatters), each supporting specific signal widths or any width.

#### Plugin Interfaces

Plugins are built around two main TypeScript interfaces defined in `frontend/src/types/plugin.ts`:

```typescript
export interface FormatView {
    id: string;                                    // Unique identifier for the view
    name: string;                                  // Display name in the UI
    supportedWidths: number[] | 'any';             // Supported signal bit-widths (e.g., [16, 32] or 'any')
    format: (val: string, width: number) => {      // The formatting function
        display: string;                           // The formatted string to display
        isX: boolean;                              // Whether the value contains undefined 'x' or 'X' bits
        isZ: boolean;                              // Whether the value contains high-impedance 'z' or 'Z' bits
    };
}

export interface FormatPlugin {
    id: string;            // Unique identifier for the plugin
    name: string;          // Name of the plugin bundle (e.g., 'IEEE 754 Float Formatter')
    views: FormatView[];   // Array of format views provided by this plugin
}
```

#### The `format` Function

The core of a plugin is the `format` function. It receives:
- `val`: A `string` containing the raw binary representation of the signal (e.g., `"1010"`, `"x"`, `"z"`). It may contain leading base indicators like `b`, though it's recommended to strip them or handle them carefully.
- `width`: A `number` indicating the bit-width of the signal.

It must return an object with:
- `display`: The final string to render on the waveform and signal list.
- `isX`: True if the value is undefined (X).
- `isZ`: True if the value is high-impedance (Z).

#### Example: A Custom Boolean Plugin

Here is a simple example of a plugin that formats 1-bit signals as `True` or `False`.

**TypeScript:**
```typescript
import type { FormatPlugin } from './types/plugin';

export const myBooleanPlugin: FormatPlugin = {
    id: 'my_boolean',
    name: 'Boolean Formatter',
    views: [
        {
            id: 'Bool',
            name: 'True/False',
            supportedWidths: [1], // Only supports 1-bit signals
            format: (val: string, width: number) => {
                // Handle X and Z states
                const isX = val.toLowerCase().includes('x');
                const isZ = val.toLowerCase().includes('z');
                
                if (isX) return { display: 'X', isX, isZ };
                if (isZ) return { display: 'Z', isX, isZ };

                // Parse binary value
                const cleanVal = val.replace(/^[bB]/, ''); // remove 'b' prefix if any
                const boolValue = parseInt(cleanVal, 2) === 1;

                return {
                    display: boolValue ? 'True' : 'False',
                    isX: false,
                    isZ: false
                };
            }
        }
    ]
};
```

**JavaScript:**
```javascript
const myBooleanPlugin = {
    id: 'my_boolean',
    name: 'Boolean Formatter',
    views: [
        {
            id: 'Bool',
            name: 'True/False',
            supportedWidths: [1],
            format: (val, width) => {
                const isX = val.toLowerCase().includes('x');
                const isZ = val.toLowerCase().includes('z');
                
                if (isX) return { display: 'X', isX, isZ };
                if (isZ) return { display: 'Z', isX, isZ };

                const cleanVal = val.replace(/^[bB]/, '');
                const boolValue = parseInt(cleanVal, 2) === 1;

                return {
                    display: boolValue ? 'True' : 'False',
                    isX: false,
                    isZ: false
                };
            }
        }
    ]
};
```

#### Registering Your Plugin

Plugins can be registered in two ways:

##### 1. Built-in Core Plugins
If you are adding a built-in plugin directly to the repository:
1. Place your plugin file in `frontend/src/plugins/`.
2. Import it in `frontend/src/hooks/useAppContext.tsx`.
3. Add it to the `formatPlugins` array in the `initialState` of `useAppContext.tsx`.

##### 2. Dynamically (At Runtime)
For external plugins loaded at runtime, the application exposes a global registration method on the `window` object:

```javascript
window.WaveformViewer.registerPlugin(myBooleanPlugin);
```

When this is called, the plugin is dispatched to the application state and becomes immediately available in the UI for users to select for matching signals.

#### Handling Base Prefixes and Padding
Signals passed to the `format` function might need parsing. A common utility pattern used in the core plugins is to strip the binary prefix and pad the string to the correct width:

```typescript
function parseBase(val: string, width: number) {
    let raw = val;
    if (raw.startsWith('b') || raw.startsWith('B')) raw = raw.slice(1);

    const isX = raw.includes('x') || raw.includes('X');
    const isZ = raw.includes('z') || raw.includes('Z');

    const paddedBin = raw.padStart(width, '0');
    return { isX, isZ, paddedBin };
}
```
Using this pattern ensures uniform handling for 'X'/'Z' states and proper alignment for arithmetic conversions.
