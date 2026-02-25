# Waveform Viewer for VSCode

A fast, interactive VCD (Value Change Dump) waveform viewer specifically designed for Visual Studio Code. This extension allows you to open and analyze `.vcd` files natively within your editor without needing external tools.

## Features

- **Native VSCode Integration**: Open any `.vcd` file directly in your workspace.
- **High Performance**: Powered by a highly optimized WebAssembly (Wasm) parser and a React-based rendering engine to support very large files out of the box.
- **Interactive Timeline**: Scroll, zoom, and navigate your waveforms efficiently.
- **Signal Browsing and Hierarchy**: Easily browse through complex Chisel or Verilog signal hierarchies and toggle visibility.

## Usage

1. Open any `.vcd` file in your VSCode workspace.
2. The Waveform Viewer will automatically render the traces.
3. Use the **Toggle Chisel Hierarchy** command or the toolbar to navigate the signals tree.
4. **Zoom In / Zoom Out / Zoom Fit**: Control the visible timeline via commands or mouse wheel.
5. **Format Plugin**: Custom signal formatting available via internal commands.

## Getting Started

Simply install the extension, open a `.vcd` artifact generated from your HDL simulator (e.g., Verilator, Icarus Verilog), and start debugging!

## Feedback and Issues

If you encounter any issues or have feature requests, please submit them to our [GitHub Repository](https://github.com/nanjo712/Waveform-Viewer).
