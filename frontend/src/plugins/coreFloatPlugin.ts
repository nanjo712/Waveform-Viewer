import type { FormatPlugin } from '../types/plugin';

export const coreFloatPlugin: FormatPlugin = {
    id: 'core_float',
    name: 'IEEE 754 Float Formatter',
    views: [
        {
            id: 'FP16',
            name: 'FP16',
            supportedWidths: [16],
            format: (val: string, width: number) => {
                if (width !== 16) return { display: 'NaN', isX: false, isZ: false };
                const { isX, isZ, paddedBin } = parseBase(val, width);
                if (isX) return { display: 'X', isX, isZ };
                if (isZ) return { display: 'Z', isX, isZ };

                try {
                    const bigValue = BigInt('0b' + paddedBin);
                    const num16 = Number(bigValue);
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
                    return { display: fp16Val.toString(), isX, isZ };
                } catch {
                    return { display: 'NaN', isX, isZ };
                }
            }
        },
        {
            id: 'FP32',
            name: 'FP32',
            supportedWidths: [32],
            format: (val: string, width: number) => {
                if (width !== 32) return { display: 'NaN', isX: false, isZ: false };
                const { isX, isZ, paddedBin } = parseBase(val, width);
                if (isX) return { display: 'X', isX, isZ };
                if (isZ) return { display: 'Z', isX, isZ };

                try {
                    const bigValue = BigInt('0b' + paddedBin);
                    const buffer = new ArrayBuffer(4);
                    const view = new DataView(buffer);
                    view.setUint32(0, Number(bigValue), false);
                    return { display: view.getFloat32(0, false).toString(), isX, isZ };
                } catch {
                    return { display: 'NaN', isX, isZ };
                }
            }
        },
        {
            id: 'FP64',
            name: 'FP64',
            supportedWidths: [64],
            format: (val: string, width: number) => {
                if (width !== 64) return { display: 'NaN', isX: false, isZ: false };
                const { isX, isZ, paddedBin } = parseBase(val, width);
                if (isX) return { display: 'X', isX, isZ };
                if (isZ) return { display: 'Z', isX, isZ };

                try {
                    const bigValue = BigInt('0b' + paddedBin);
                    const buffer = new ArrayBuffer(8);
                    const view = new DataView(buffer);
                    const high = Number(bigValue >> 32n);
                    const low = Number(bigValue & 0xFFFFFFFFn);
                    view.setUint32(0, high, false);
                    view.setUint32(4, low, false);
                    return { display: view.getFloat64(0, false).toString(), isX, isZ };
                } catch {
                    return { display: 'NaN', isX, isZ };
                }
            }
        }
    ]
};

function parseBase(val: string, width: number) {
    let raw = val;
    if (raw.startsWith('b') || raw.startsWith('B')) raw = raw.slice(1);

    // Check for X or Z which overrides any formatting
    const isX = raw.includes('x') || raw.includes('X');
    const isZ = raw.includes('z') || raw.includes('Z');

    const paddedBin = raw.padStart(width, '0');
    return { isX, isZ, paddedBin };
}
