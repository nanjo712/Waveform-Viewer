export interface FormatView {
    id: string;
    name: string;
    supportedWidths: number[] | 'any';
    format: (val: string, width: number) => {
        display: string;
        isX: boolean;
        isZ: boolean;
    };
}
export interface FormatPlugin {
    id: string;
    name: string;
    views: FormatView[];
}
