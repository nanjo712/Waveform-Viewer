import type { FormatPlugin } from '../types/plugin';

export const coreRadixPlugin: FormatPlugin = {
    id: 'core_radix',
    name: 'Standard Radix Formatter',
    views: [
        {
            id: 'Bin',
            name: 'Binary',
            supportedWidths: 'any',
            format: (val: string, width: number) => {
                const { isX, isZ, paddedBin } = parseBase(val, width);
                if (isX) return { display: 'X', isX, isZ };
                if (isZ) return { display: 'Z', isX, isZ };
                return { display: 'b' + paddedBin, isX, isZ };
            }
        },
        {
            id: 'Oct',
            name: 'Octal',
            supportedWidths: 'any',
            format: (val: string, width: number) => {
                const { isX, isZ, paddedBin } = parseBase(val, width);
                if (isX) return { display: 'X', isX, isZ };
                if (isZ) return { display: 'Z', isX, isZ };
                try {
                    const bigValue = BigInt('0b' + paddedBin);
                    return { display: '0o' + bigValue.toString(8), isX, isZ };
                } catch {
                    return { display: paddedBin, isX, isZ };
                }
            }
        },
        {
            id: 'Dec',
            name: 'Decimal',
            supportedWidths: 'any',
            format: (val: string, width: number) => {
                const { isX, isZ, paddedBin } = parseBase(val, width);
                if (isX) return { display: 'X', isX, isZ };
                if (isZ) return { display: 'Z', isX, isZ };
                try {
                    const bigValue = BigInt('0b' + paddedBin);
                    return { display: bigValue.toString(10), isX, isZ };
                } catch {
                    return { display: paddedBin, isX, isZ };
                }
            }
        },
        {
            id: 'Hex',
            name: 'Hexadecimal',
            supportedWidths: 'any',
            format: (val: string, width: number) => {
                const { isX, isZ, paddedBin } = parseBase(val, width);
                if (isX) return { display: 'X', isX, isZ };
                if (isZ) return { display: 'Z', isX, isZ };
                try {
                    const bigValue = BigInt('0b' + paddedBin);
                    return { display: '0x' + bigValue.toString(16).toUpperCase(), isX, isZ };
                } catch {
                    return { display: paddedBin, isX, isZ };
                }
            }
        },
        {
            id: 'ASCII',
            name: 'ASCII',
            supportedWidths: 'any',
            format: (val: string, width: number) => {
                const { isX, isZ, paddedBin } = parseBase(val, width);
                if (isX) return { display: 'X', isX, isZ };
                if (isZ) return { display: 'Z', isX, isZ };
                try {
                    const bigValue = BigInt('0b' + paddedBin);
                    let asciiStr = '';
                    const hexStr = paddedBin.length % 4 === 0
                        ? bigValue.toString(16).padStart(paddedBin.length / 4, '0')
                        : bigValue.toString(16);
                    for (let i = 0; i < hexStr.length; i += 2) {
                        const byteHex = hexStr.substring(i, i + 2);
                        if (byteHex.length === 2) {
                            const charCode = parseInt(byteHex, 16);
                            if (charCode >= 32 && charCode <= 126) {
                                asciiStr += String.fromCharCode(charCode);
                            } else {
                                asciiStr += '.'; // placeholder for non-printable
                            }
                        }
                    }
                    return { display: asciiStr || '.', isX, isZ };
                } catch {
                    return { display: paddedBin, isX, isZ };
                }
            }
        }
    ]
};

function parseBase(val: string, width: number) {
    let raw = val;
    if (raw.startsWith('b') || raw.startsWith('B')) raw = raw.slice(1);

    const isX = raw.includes('x') || raw.includes('X');
    const isZ = raw.includes('z') || raw.includes('Z');

    const paddedBin = raw.padStart(width, '0');
    return { isX, isZ, paddedBin };
}
