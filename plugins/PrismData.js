window.WaveformViewer.registerPlugin({
    id: "prism_data",
    name: "PrismData",
    views: [
        {
            id: "Complex32",
            name: "Complex32",
            supportedWidths: [64],
            format: (val, width) => {
                if (width !== 64) return { display: 'NaN', isX: false, isZ: false };
                const parsed = parseBase(val, width);
                if (parsed.isX) return { display: 'X', isX: true, isZ: false };
                if (parsed.isZ) return { display: 'Z', isX: false, isZ: true };

                // Higher 32 bits = Imaginary, Lower 32 bits = Real
                const imagBin = parsed.paddedBin.slice(0, 32);
                const realBin = parsed.paddedBin.slice(32, 64);

                const real = binToFloat32(realBin);
                const imag = binToFloat32(imagBin);

                const sign = imag < 0 ? '-' : '+';
                return { display: `${real}${sign}${Math.abs(imag)}i`, isX: false, isZ: false };
            }
        },
        {
            id: "FP32x2",
            name: "FP32",
            supportedWidths: [64],
            format: (val, width) => {
                if (width !== 64) return { display: 'NaN', isX: false, isZ: false };
                const parsed = parseBase(val, width);
                if (parsed.isX) return { display: 'X', isX: true, isZ: false };
                if (parsed.isZ) return { display: 'Z', isX: false, isZ: true };

                const highBin = parsed.paddedBin.slice(0, 32);
                const lowBin = parsed.paddedBin.slice(32, 64);

                return { display: `${binToFloat32(highBin)} ${binToFloat32(lowBin)}`, isX: false, isZ: false };
            }
        },
        {
            id: "BF16x4",
            name: "BF16",
            supportedWidths: [64],
            format: (val, width) => {
                if (width !== 64) return { display: 'NaN', isX: false, isZ: false };
                const parsed = parseBase(val, width);
                if (parsed.isX) return { display: 'X', isX: true, isZ: false };
                if (parsed.isZ) return { display: 'Z', isX: false, isZ: true };

                const res = [];
                for (let i = 0; i < 4; i++) {
                    const chunk = parsed.paddedBin.slice(i * 16, (i + 1) * 16);
                    res.push(binToBFloat16(chunk));
                }
                return { display: res.join(' '), isX: false, isZ: false };
            }
        },
        {
            id: "INT8x8",
            name: "INT8",
            supportedWidths: [64],
            format: (val, width) => {
                if (width !== 64) return { display: 'NaN', isX: false, isZ: false };
                const parsed = parseBase(val, width);
                if (parsed.isX) return { display: 'X', isX: true, isZ: false };
                if (parsed.isZ) return { display: 'Z', isX: false, isZ: true };

                const res = [];
                for (let i = 0; i < 8; i++) {
                    const chunk = parsed.paddedBin.slice(i * 8, (i + 1) * 8);
                    res.push(binToInt8(chunk));
                }
                return { display: res.join(' '), isX: false, isZ: false };
            }
        }
    ]
});

// Helper functions
function parseBase(val, width) {
    let raw = val;
    if (raw.startsWith('b') || raw.startsWith('B')) raw = raw.slice(1);

    // Check for X or Z which overrides any formatting
    const isX = raw.includes('x') || raw.includes('X');
    const isZ = raw.includes('z') || raw.includes('Z');

    const paddedBin = raw.padStart(width, '0');
    return { isX, isZ, paddedBin };
}

function binToFloat32(binStr) {
    const intVal = parseInt(binStr, 2);
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setUint32(0, intVal, false); // big endian (read left to right bits)
    return parseFloat(view.getFloat32(0, false).toPrecision(7)); // Cleanup floating artifacts
}

function binToBFloat16(binStr) {
    // BF16 is the upper 16 bits of an FP32
    const float32Bin = binStr + '0000000000000000';
    return binToFloat32(float32Bin);
}

function binToInt8(binStr) {
    const intVal = parseInt(binStr, 2);
    // Convert to signed 8-bit integer
    return intVal > 127 ? intVal - 256 : intVal;
}
