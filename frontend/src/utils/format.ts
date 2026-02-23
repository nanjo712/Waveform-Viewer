export function formatSignalValue(val: string, width: number, format: string): { display: string; isX: boolean; isZ: boolean } {
    let raw = val;
    // Strip metric prefixes except if the value itself begins with a valid hex/bin pattern not overlapping
    if (raw.startsWith('b') || raw.startsWith('B')) raw = raw.slice(1);

    // Check for X or Z which overrides any formatting
    const isX = raw.includes('x') || raw.includes('X');
    const isZ = raw.includes('z') || raw.includes('Z');

    if (isX) return { display: 'X', isX: true, isZ: false };
    if (isZ) return { display: 'Z', isX: false, isZ: true };

    // Real floats (e.g. from SystemVerilog logic/real types mapped to VCD 'r' type)
    if (raw.startsWith('r') || raw.startsWith('R')) {
        const n = parseFloat(raw.slice(1));
        return { display: n.toString(), isX: false, isZ: false };
    }

    // Zero-pad the binary string to the signal width
    const paddedBin = raw.padStart(width, '0');

    // For bases 2, 8, 10, 16 use BigInt to avoid double rounding errors on wide buses
    let bigValue: bigint;
    try {
        bigValue = BigInt('0b' + paddedBin);
    } catch {
        // Fallback in case padding resulted in non-binary chars somehow
        return { display: paddedBin, isX: false, isZ: false };
    }

    switch (format) {
        case 'Bin':
            return { display: 'b' + paddedBin, isX: false, isZ: false };
        case 'Oct':
            return { display: '0o' + bigValue.toString(8), isX: false, isZ: false };
        case 'Dec':
            return { display: bigValue.toString(10), isX: false, isZ: false };
        case 'Hex':
            return { display: '0x' + bigValue.toString(16).toUpperCase(), isX: false, isZ: false };
        case 'FP16': {
            if (width !== 16) return { display: 'NaN', isX: false, isZ: false };
            const num16 = Number(bigValue);
            // FP16 manual decode: 1 sign, 5 exp, 10 frac
            const sign = (num16 >> 15) & 1;
            const exp = (num16 >> 10) & 0x1F;
            const frac = num16 & 0x3FF;
            let fp16Val: number;
            if (exp === 0) {
                fp16Val = (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024);
            } else if (exp === 0x1F) {
                fp16Val = frac === 0 ? (sign ? -Infinity : Infinity) : NaN;
            } else {
                fp16Val = (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
            }
            return { display: fp16Val.toString(), isX: false, isZ: false };
        }
        case 'FP32': {
            if (width !== 32) return { display: 'NaN', isX: false, isZ: false };
            const buffer = new ArrayBuffer(4);
            const view = new DataView(buffer);
            view.setUint32(0, Number(bigValue), false);
            return { display: view.getFloat32(0, false).toString(), isX: false, isZ: false };
        }
        case 'FP64': {
            if (width !== 64) return { display: 'NaN', isX: false, isZ: false };
            const buffer = new ArrayBuffer(8);
            const view = new DataView(buffer);
            const bigNum = bigValue;
            const high = Number(bigNum >> 32n);
            const low = Number(bigNum & 0xFFFFFFFFn);
            view.setUint32(0, high, false);
            view.setUint32(4, low, false);
            return { display: view.getFloat64(0, false).toString(), isX: false, isZ: false };
        }
        case 'ASCII': {
            let asciiStr = '';
            const hexStr = paddedBin.length % 4 === 0
                ? bigValue.toString(16).padStart(paddedBin.length / 4, '0')
                : bigValue.toString(16);
            for (let i = 0; i < hexStr.length; i += 2) {
                const byteHex = hexStr.substr(i, 2);
                if (byteHex.length === 2) {
                    const charCode = parseInt(byteHex, 16);
                    if (charCode >= 32 && charCode <= 126) {
                        asciiStr += String.fromCharCode(charCode);
                    } else {
                        asciiStr += '.'; // placeholder for non-printable
                    }
                }
            }
            return { display: asciiStr || '.', isX: false, isZ: false };
        }
        default:
            return { display: '0x' + bigValue.toString(16).toUpperCase(), isX: false, isZ: false };
    }
}
