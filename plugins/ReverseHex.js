// reverse_hex.js
window.WaveformViewer.registerPlugin({
    id: "custom_rev_radix",
    name: "Reverse Radix Extender",
    views: [
        {
            id: "RevHex",
            name: "Reverse Hexadecimal",
            supportedWidths: "any",
            format: (val, width) => {
                let r = val;
                if (r.startsWith('b') || r.startsWith('B')) r = r.slice(1);

                const isX = r.includes('x') || r.includes('X');
                const isZ = r.includes('z') || r.includes('Z');

                if (isX) return { display: 'X', isX: true, isZ: false };
                if (isZ) return { display: 'Z', isX: false, isZ: true };

                // Reverse the padded bin string
                const paddedBin = r.padStart(width, '0');
                const reversed = paddedBin.split("").reverse().join("");

                try {
                    const bigValue = BigInt('0b' + reversed);
                    return { display: '0x' + bigValue.toString(16).toUpperCase(), isX: false, isZ: false };
                } catch {
                    return { display: "ERR", isX: false, isZ: false };
                }
            }
        }
    ]
});
