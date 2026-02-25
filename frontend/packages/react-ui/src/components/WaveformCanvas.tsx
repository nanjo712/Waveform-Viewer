import {
    useRef,
    useEffect,
    useCallback,
    useMemo,
    useState,
} from 'react';
import { useAppContext } from '../hooks/useAppContext.tsx';
import { unflattenChisel, buildSignalDisplayMap } from '@waveform-viewer/core';
import type { SignalQueryResult, SignalDisplayInfo } from '@waveform-viewer/core';


// ── Color palette for signals ──────────────────────────────────────

const SIGNAL_COLORS = [
    '#4ec9b0', // green
    '#569cd6', // blue
    '#dcdcaa', // yellow
    '#ce9178', // orange
    '#c586c0', // purple
    '#4fc1ff', // cyan
    '#d16d9e', // pink
    '#b5cea8', // lime
    '#f44747', // red
    '#d7ba7d', // gold
];

function getSignalColor(index: number): string {
    return SIGNAL_COLORS[index % SIGNAL_COLORS.length];
}

// ── Value parsing helpers ──────────────────────────────────────────

function parseBitValue(val: string): number | null {
    if (val === '1') return 1;
    if (val === '0') return 0;
    if (val === 'x' || val === 'X') return -1; // unknown
    if (val === 'z' || val === 'Z') return -2; // high-z
    return null;
}

// ── Time axis formatting ───────────────────────────────────────────

function formatTime(t: number, unit: string): string {
    return t.toLocaleString() + ' ' + unit;
}

function niceStep(range: number, maxTicks: number): number {
    const rough = range / maxTicks;
    const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / pow10;
    let step: number;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 5) step = 5;
    else step = 10;
    return step * pow10;
}

// ── Drawing constants ──────────────────────────────────────────────

const ROW_HEIGHT = 48;
const HEADER_HEIGHT = 30;
const TIMELINE_HEIGHT = 28;
const DPR = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

// ── Component ──────────────────────────────────────────────────────

export function WaveformCanvas() {
    const { state, dispatch } = useAppContext();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const signalNamesRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{
        dragging: boolean;
        startX: number;
        startViewStart: number;
        startViewEnd: number;
    }>({ dragging: false, startX: 0, startViewStart: 0, startViewEnd: 0 });
    const animFrameRef = useRef<number>(0);

    const unit = state.metadata?.timescaleUnit ?? 'ns';

    // ── Build a map from signal index to query result ──────────────

    const signalResultMap = useMemo(() => {
        const map = new Map<number, SignalQueryResult>();
        if (state.queryResult) {
            for (const sr of state.queryResult.signals) {
                map.set(sr.index, sr);
            }
        }
        return map;
    }, [state.queryResult]);

    // ── Build display-name map when Chisel mode is active ─────────

    const displayMap = useMemo<Map<number, SignalDisplayInfo> | null>(() => {
        if (!state.unflattenChisel || !state.hierarchy) return null;
        const tree = unflattenChisel(state.hierarchy, state.signals);
        return buildSignalDisplayMap(tree);
    }, [state.unflattenChisel, state.hierarchy, state.signals]);

    // ── Tooltip state for signal name hover ───────────────────────

    const [tooltip, setTooltip] = useState<{
        visible: boolean;
        x: number;
        y: number;
        lines: string[];
    }>({ visible: false, x: 0, y: 0, lines: [] });

    const handleSignalMouseEnter = useCallback(
        (e: React.MouseEvent, sigIdx: number) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const info = displayMap?.get(sigIdx);
            const sig = state.signals[sigIdx];
            if (!sig) return;

            let lines: string[];
            if (info && info.scopePath.length > 0) {
                // Chisel mode: show scope path + display name
                lines = [...info.scopePath, info.displayName];
            } else if (info) {
                // Chisel mode but signal is at root level
                lines = [info.displayName];
            } else {
                // Non-Chisel mode: show full hierarchical path
                lines = sig.fullPath.split('.');
            }

            setTooltip({
                visible: true,
                x: rect.right + 8,
                y: rect.top + rect.height / 2,
                lines,
            });
        },
        [displayMap, state.signals]
    );

    const handleSignalMouseLeave = useCallback(() => {
        setTooltip(prev => ({ ...prev, visible: false }));
    }, []);

    // ── Draw function ──────────────────────────────────────────────

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        const rect = container.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;

        // Virtual scroll calculations with 3x buffer (1x above + 1x visible + 1x below)
        const scrollTop = container.scrollTop;
        const numVisibleRows = Math.ceil(h / ROW_HEIGHT) + 1;
        const bufferRows = numVisibleRows; // 1x buffer
        const rawStart = Math.floor((scrollTop - HEADER_HEIGHT - TIMELINE_HEIGHT) / ROW_HEIGHT);
        const startRow = Math.max(0, rawStart - bufferRows);
        const endRow = Math.min(state.selectedSignals.length, rawStart + numVisibleRows + bufferRows);

        // Update visible rows context so we only query what we see
        const visibleIndices = state.selectedSignals.slice(startRow, endRow);
        dispatch({ type: 'SET_VISIBLE_ROWS', indices: visibleIndices });

        canvas.width = w * DPR;
        canvas.height = h * DPR;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.scale(DPR, DPR);

        // Clear
        ctx.fillStyle = '#1e1e1e';
        ctx.fillRect(0, 0, w, h);

        const viewStart = state.viewStart;
        const viewEnd = state.viewEnd;
        const viewRange = viewEnd - viewStart;
        if (viewRange <= 0) return;

        const timeToX = (t: number) => ((t - viewStart) / viewRange) * w;

        // ── Draw timeline axis ────────────────────────────────────

        const timelineY = HEADER_HEIGHT;
        ctx.fillStyle = '#252526';
        ctx.fillRect(0, 0, w, timelineY + TIMELINE_HEIGHT);

        // Grid lines and time labels
        const maxTicks = Math.floor(w / 80);
        const step = niceStep(viewRange, maxTicks);
        const firstTick = Math.ceil(viewStart / step) * step;

        ctx.strokeStyle = '#2a2d2e';
        ctx.lineWidth = 1;
        ctx.font = '14px "Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, "Courier New", monospace';
        ctx.fillStyle = '#9d9d9d';
        ctx.textAlign = 'center';

        for (let t = firstTick; t <= viewEnd; t += step) {
            const x = Math.round(timeToX(t)) + 0.5;

            // Vertical grid line (full height)
            ctx.beginPath();
            ctx.moveTo(x, timelineY + TIMELINE_HEIGHT);
            ctx.lineTo(x, h);
            ctx.stroke();

            // Tick mark
            ctx.beginPath();
            ctx.strokeStyle = '#6a6a6a';
            ctx.moveTo(x, timelineY + TIMELINE_HEIGHT - 6);
            ctx.lineTo(x, timelineY + TIMELINE_HEIGHT);
            ctx.stroke();
            ctx.strokeStyle = '#2a2d2e';

            // Label
            ctx.fillText(formatTime(t, unit), x, timelineY + TIMELINE_HEIGHT - 10);
        }

        // Timeline bottom border
        ctx.strokeStyle = '#3c3c3c';
        ctx.beginPath();
        ctx.moveTo(0, timelineY + TIMELINE_HEIGHT + 0.5);
        ctx.lineTo(w, timelineY + TIMELINE_HEIGHT + 0.5);
        ctx.stroke();

        // ── Draw each signal waveform ─────────────────────────────

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, timelineY + TIMELINE_HEIGHT, w, h - (timelineY + TIMELINE_HEIGHT));
        ctx.clip();

        // Draw visible waveforms
        const drawVisibleRange = visibleIndices.map((sigIdx, relativeIndex) => {
            const rowIdx = startRow + relativeIndex;
            return { sigIdx, rowIdx };
        });

        drawVisibleRange.forEach(({ sigIdx, rowIdx }) => {
            const sig = state.signals[sigIdx];
            if (!sig) return;

            // Compute exact Y coordinates mapped from absolute document offset into sticky view
            const absoluteRowTop = HEADER_HEIGHT + TIMELINE_HEIGHT + rowIdx * ROW_HEIGHT;
            const y0 = absoluteRowTop - scrollTop;
            if (y0 > h || y0 + ROW_HEIGHT < 0) return; // double check cull

            const rowTop = y0 + 4;
            const rowBot = y0 + ROW_HEIGHT - 4;
            const rowMid = (rowTop + rowBot) / 2;
            const color = getSignalColor(rowIdx);
            ctx.strokeStyle = '#2a2d2e';
            ctx.beginPath();
            ctx.moveTo(0, y0 + ROW_HEIGHT + 0.5);
            ctx.lineTo(w, y0 + ROW_HEIGHT + 0.5);
            ctx.stroke();

            const result = signalResultMap.get(sigIdx);
            if (!result) return;

            const isSingleBit = sig.width === 1;

            if (isSingleBit) {
                drawSingleBitWaveform(
                    ctx,
                    result,
                    timeToX,
                    rowTop,
                    rowBot,
                    rowMid,
                    color,
                    w,
                    viewEnd
                );
            } else {
                const formatId = state.signalFormats[sigIdx] || 'Hex';
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let currentView: any = null;
                for (const p of state.formatPlugins) {
                    for (const v of p.views) {
                        if (v.id === formatId) {
                            currentView = v;
                            break;
                        }
                    }
                    if (currentView) break;
                }

                drawMultiBitWaveform(
                    ctx,
                    result,
                    sig.width,
                    currentView,
                    timeToX,
                    rowTop,
                    rowBot,
                    rowMid,
                    color,
                    w,
                    viewEnd
                );
            }
        });

        ctx.restore();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.selectedSignals, state.signals, state.signalFormats, state.viewStart, state.viewEnd, signalResultMap, unit, dispatch]);

    // ── Single-bit waveform drawing ────────────────────────────────

    function drawSingleBitWaveform(
        ctx: CanvasRenderingContext2D,
        result: SignalQueryResult,
        timeToX: (t: number) => number,
        rowTop: number,
        rowBot: number,
        rowMid: number,
        color: string,
        canvasWidth: number,
        viewEnd: number
    ) {
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';

        // Build value segments: [{from, to, val}]
        type Segment = { from: number; to: number; val: string };
        const segments: Segment[] = [];

        let currentVal = result.initialValue;
        let currentFrom = timeToX(state.viewStart);

        for (const [ts, val] of result.transitions) {
            const x = timeToX(ts);
            segments.push({ from: currentFrom, to: x, val: currentVal });
            currentVal = val;
            currentFrom = x;
        }
        // Last segment extends to end
        segments.push({
            from: currentFrom,
            to: timeToX(viewEnd),
            val: currentVal,
        });

        for (const seg of segments) {
            const bit = parseBitValue(seg.val);
            const fromX = Math.max(seg.from, 0);
            const toX = Math.min(seg.to, canvasWidth);
            if (fromX >= toX) continue;

            if (bit === -1) {
                // X - draw hatched red
                ctx.strokeStyle = '#f44747';
                ctx.fillStyle = 'rgba(244, 71, 71, 0.15)';
                ctx.fillRect(fromX, rowTop, toX - fromX, rowBot - rowTop);
                ctx.beginPath();
                ctx.moveTo(fromX, rowMid);
                ctx.lineTo(toX, rowMid);
                ctx.stroke();
            } else if (bit === -2) {
                // Z - draw dashed middle
                ctx.strokeStyle = '#dcdcaa';
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(fromX, rowMid);
                ctx.lineTo(toX, rowMid);
                ctx.stroke();
                ctx.setLineDash([]);
            } else {
                const yLevel = bit === 1 ? rowTop : rowBot;
                ctx.strokeStyle = color;
                ctx.beginPath();
                ctx.moveTo(fromX, yLevel);
                ctx.lineTo(toX, yLevel);
                ctx.stroke();
            }
        }

        // Draw transitions (vertical edges)
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        let prevVal = result.initialValue;
        for (const [ts, val] of result.transitions) {
            const x = timeToX(ts);
            if (x < 0 || x > canvasWidth) {
                prevVal = val;
                continue;
            }
            const prevBit = parseBitValue(prevVal);
            const curBit = parseBitValue(val);
            const prevY =
                prevBit === 1
                    ? rowTop
                    : prevBit === 0
                        ? rowBot
                        : rowMid;
            const curY =
                curBit === 1
                    ? rowTop
                    : curBit === 0
                        ? rowBot
                        : rowMid;
            ctx.beginPath();
            ctx.moveTo(x, prevY);
            ctx.lineTo(x, curY);
            ctx.stroke();
            prevVal = val;
        }
    }

    // ── Multi-bit waveform drawing (bus-style with hex values) ─────

    function drawMultiBitWaveform(
        ctx: CanvasRenderingContext2D,
        result: SignalQueryResult,
        width: number,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        formatView: any,
        timeToX: (t: number) => number,
        rowTop: number,
        rowBot: number,
        _rowMid: number,
        color: string,
        canvasWidth: number,
        viewEnd: number
    ) {
        ctx.lineWidth = 1.5;

        type Segment = { from: number; to: number; val: string };
        const segments: Segment[] = [];

        let currentVal = result.initialValue;
        let currentFrom = timeToX(state.viewStart);

        for (const [ts, val] of result.transitions) {
            const x = timeToX(ts);
            segments.push({ from: currentFrom, to: x, val: currentVal });
            currentVal = val;
            currentFrom = x;
        }
        segments.push({
            from: currentFrom,
            to: timeToX(viewEnd),
            val: currentVal,
        });

        const slant = 4; // diamond-shaped transition width

        for (const seg of segments) {
            const fromX = Math.max(seg.from, -slant);
            const toX = Math.min(seg.to, canvasWidth + slant);
            if (fromX >= toX) continue;

            const fallbackFormat = (val: string, w: number) => {
                let r = val;
                if (r.startsWith('b') || r.startsWith('B')) r = r.slice(1);
                const isX = r.includes('x') || r.includes('X');
                const isZ = r.includes('z') || r.includes('Z');
                if (isX) return { display: 'X', isX: true, isZ: false };
                if (isZ) return { display: 'Z', isX: false, isZ: true };
                try {
                    const bigValue = BigInt('0b' + r.padStart(w, '0'));
                    return { display: '0x' + bigValue.toString(16).toUpperCase(), isX: false, isZ: false };
                } catch {
                    return { display: r, isX: false, isZ: false };
                }
            };

            const formatter = formatView?.format || fallbackFormat;
            const parsed = formatter(seg.val, width);

            if (parsed.isX) {
                ctx.fillStyle = 'rgba(244, 71, 71, 0.15)';
                ctx.strokeStyle = '#f44747';
            } else if (parsed.isZ) {
                ctx.fillStyle = 'rgba(220, 220, 170, 0.1)';
                ctx.strokeStyle = '#dcdcaa';
            } else {
                ctx.fillStyle = color + '18'; // very low alpha fill
                ctx.strokeStyle = color;
            }

            // Draw diamond/trapezoid shape
            ctx.beginPath();
            ctx.moveTo(fromX + slant, rowTop);
            ctx.lineTo(toX - slant, rowTop);
            ctx.lineTo(toX, (rowTop + rowBot) / 2);
            ctx.lineTo(toX - slant, rowBot);
            ctx.lineTo(fromX + slant, rowBot);
            ctx.lineTo(fromX, (rowTop + rowBot) / 2);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // Draw value text if segment is wide enough
            const segWidth = toX - fromX;
            if (segWidth > 30) {
                ctx.fillStyle = color;
                ctx.font = '14px "Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, "Courier New", monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const textX = (fromX + toX) / 2;
                const textY = (rowTop + rowBot) / 2;

                // Clip text to segment
                ctx.save();
                ctx.beginPath();
                ctx.rect(fromX + slant + 2, rowTop, segWidth - 2 * slant - 4, rowBot - rowTop);
                ctx.clip();
                ctx.fillText(parsed.display, textX, textY);
                ctx.restore();
            }
        }
    }

    // ── Resize observer ────────────────────────────────────────────

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const obs = new ResizeObserver(() => {
            cancelAnimationFrame(animFrameRef.current);
            animFrameRef.current = requestAnimationFrame(draw);
        });
        obs.observe(container);
        return () => obs.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draw, state.selectedSignals.length]);

    // ── Redraw on state change ─────────────────────────────────────

    useEffect(() => {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = requestAnimationFrame(draw);
    }, [draw]);

    // ── Wheel zoom (native listener for non-passive preventDefault) ──

    const handleWheel = useCallback(
        (e: WheelEvent) => {
            e.preventDefault();
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return;

            const mouseX = e.clientX - rect.left;
            const w = rect.width;
            const fraction = mouseX / w;

            const viewRange = state.viewEnd - state.viewStart;
            const zoomFactor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
            const newRange = Math.max(1, viewRange * zoomFactor);

            // Clamp to full time range
            const fullRange = state.timeEnd - state.timeBegin;
            const clampedRange = Math.min(newRange, fullRange);

            // Keep the point under the mouse cursor fixed
            const mouseTime = state.viewStart + fraction * viewRange;
            let newStart = mouseTime - fraction * clampedRange;
            let newEnd = newStart + clampedRange;

            // Clamp to bounds
            if (newStart < state.timeBegin) {
                newStart = state.timeBegin;
                newEnd = newStart + clampedRange;
            }
            if (newEnd > state.timeEnd) {
                newEnd = state.timeEnd;
                newStart = newEnd - clampedRange;
            }

            dispatch({
                type: 'SET_VIEW',
                start: Math.max(state.timeBegin, newStart),
                end: Math.min(state.timeEnd, newEnd),
            });
        },
        [state.viewStart, state.viewEnd, state.timeBegin, state.timeEnd, dispatch]
    );

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        el.addEventListener('wheel', handleWheel, { passive: false });
        return () => el.removeEventListener('wheel', handleWheel);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [handleWheel, state.selectedSignals.length]);

    // ── Synchronized vertical scrolling ────────────────────────────

    const handleCanvasScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        if (signalNamesRef.current && signalNamesRef.current.scrollTop !== e.currentTarget.scrollTop) {
            signalNamesRef.current.scrollTop = e.currentTarget.scrollTop;
        }
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = requestAnimationFrame(draw);
    }, [draw]);

    const handleNamesScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        if (containerRef.current && containerRef.current.scrollTop !== e.currentTarget.scrollTop) {
            containerRef.current.scrollTop = e.currentTarget.scrollTop;
        }
    }, []);

    // ── Mouse drag for panning ─────────────────────────────────────

    const handleMouseDown = useCallback(
        (e: React.MouseEvent) => {
            if (e.button !== 0) return;
            dragRef.current = {
                dragging: true,
                startX: e.clientX,
                startViewStart: state.viewStart,
                startViewEnd: state.viewEnd,
            };
            if (containerRef.current) {
                containerRef.current.style.cursor = 'grabbing';
            }
            e.preventDefault();
        },
        [state.viewStart, state.viewEnd]
    );

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!dragRef.current.dragging) return;
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return;

            const dx = e.clientX - dragRef.current.startX;
            const viewRange =
                dragRef.current.startViewEnd - dragRef.current.startViewStart;
            const timeDelta = -(dx / rect.width) * viewRange;

            let newStart = dragRef.current.startViewStart + timeDelta;
            let newEnd = dragRef.current.startViewEnd + timeDelta;

            // Clamp
            if (newStart < state.timeBegin) {
                newStart = state.timeBegin;
                newEnd = newStart + viewRange;
            }
            if (newEnd > state.timeEnd) {
                newEnd = state.timeEnd;
                newStart = newEnd - viewRange;
            }

            dispatch({ type: 'SET_VIEW', start: newStart, end: newEnd });
        };

        const handleMouseUp = () => {
            dragRef.current.dragging = false;
            if (containerRef.current) {
                containerRef.current.style.cursor = 'grab';
            }
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [state.timeBegin, state.timeEnd, dispatch]);

    // ── Zoom controls ──────────────────────────────────────────────

    const handleZoomIn = useCallback(() => {
        const range = state.viewEnd - state.viewStart;
        const newRange = range / 1.5;
        const center = (state.viewStart + state.viewEnd) / 2;
        dispatch({
            type: 'SET_VIEW',
            start: Math.max(state.timeBegin, center - newRange / 2),
            end: Math.min(state.timeEnd, center + newRange / 2),
        });
    }, [state, dispatch]);

    const handleZoomOut = useCallback(() => {
        const range = state.viewEnd - state.viewStart;
        const newRange = Math.min(range * 1.5, state.timeEnd - state.timeBegin);
        const center = (state.viewStart + state.viewEnd) / 2;
        let start = center - newRange / 2;
        let end = center + newRange / 2;
        if (start < state.timeBegin) {
            start = state.timeBegin;
            end = start + newRange;
        }
        if (end > state.timeEnd) {
            end = state.timeEnd;
            start = end - newRange;
        }
        dispatch({ type: 'SET_VIEW', start, end });
    }, [state, dispatch]);

    const handleZoomFit = useCallback(() => {
        dispatch({
            type: 'SET_VIEW',
            start: state.timeBegin,
            end: state.timeEnd,
        });
    }, [state.timeBegin, state.timeEnd, dispatch]);

    // ── Render ─────────────────────────────────────────────────────

    if (!state.fileLoaded) {
        return (
            <div className="waveform-panel">
                <div className="empty-state">
                    <div className="empty-state-icon">&#9776;</div>
                    <div className="empty-state-text">
                        Open a VCD file to view waveforms
                    </div>
                    <div className="empty-state-hint">
                        Click "Open VCD" in the title bar
                    </div>
                </div>
            </div>
        );
    }

    if (state.selectedSignals.length === 0) {
        return (
            <div className="waveform-panel">
                <div className="waveform-toolbar">
                    <span className="time-info">
                        View: {formatTime(state.viewStart, unit)} -{' '}
                        {formatTime(state.viewEnd, unit)}
                    </span>
                    <div className="zoom-controls">
                        <button className="btn btn-icon" onClick={handleZoomIn} title="Zoom In">+</button>
                        <button className="btn btn-icon" onClick={handleZoomOut} title="Zoom Out">-</button>
                        <button className="btn btn-icon" onClick={handleZoomFit} title="Fit">[ ]</button>
                    </div>
                </div>
                <div className="empty-state">
                    <div className="empty-state-icon">&#8592;</div>
                    <div className="empty-state-text">
                        Select signals from the sidebar to display waveforms
                    </div>
                </div>
            </div>
        );
    }

    const totalHeight = HEADER_HEIGHT + TIMELINE_HEIGHT + state.selectedSignals.length * ROW_HEIGHT;

    // Names Virtualization with 3x buffer
    const namesContainer = signalNamesRef.current;
    const currentNamesScroll = namesContainer?.scrollTop ?? 0;
    const viewHeight = namesContainer?.clientHeight ?? 800;
    const numVisibleNames = Math.ceil(viewHeight / ROW_HEIGHT) + 1;
    const bufferNames = numVisibleNames; // 1x buffer
    const rawStartNames = Math.floor((currentNamesScroll - HEADER_HEIGHT - TIMELINE_HEIGHT) / ROW_HEIGHT);
    const startRowNames = Math.max(0, rawStartNames - bufferNames);
    const endRowNames = Math.min(state.selectedSignals.length, rawStartNames + numVisibleNames + bufferNames);

    const visibleNamesData = state.selectedSignals.slice(startRowNames, endRowNames).map((sigIdx, i) => ({
        sigIdx,
        rowIdx: startRowNames + i,
    }));

    const paddingTop = startRowNames * ROW_HEIGHT;

    return (
        <div className="waveform-panel">
            <div className="waveform-toolbar">
                <span className="time-info">
                    View: {formatTime(state.viewStart, unit)} -{' '}
                    {formatTime(state.viewEnd, unit)}
                </span>

                {state.activeSignalIndex !== null && state.signals[state.activeSignalIndex] && state.signals[state.activeSignalIndex].width > 1 && (
                    <div className="active-signal-format">
                        <span className="format-label" style={{ marginRight: '8px', color: 'var(--text-muted)' }}>Format ({state.signals[state.activeSignalIndex].name}):</span>
                        <select
                            className="signal-format"
                            value={state.signalFormats[state.activeSignalIndex] || 'Hex'}
                            onChange={(e) => dispatch({ type: 'SET_SIGNAL_FORMAT', index: state.activeSignalIndex!, format: e.target.value })}
                            title="Format"
                        >
                            {state.formatPlugins.map(plugin => {
                                const activeSig = state.signals[state.activeSignalIndex!];
                                const validViews = plugin.views.filter(v => v.supportedWidths === 'any' || v.supportedWidths.includes(activeSig.width));
                                if (validViews.length === 0) return null;
                                return (
                                    <optgroup key={plugin.id} label={plugin.name}>
                                        {validViews.map(v => (
                                            <option key={v.id} value={v.id}>{v.name}</option>
                                        ))}
                                    </optgroup>
                                );
                            })}
                        </select>
                    </div>
                )}

                <div className="zoom-controls">
                    <button className="btn btn-icon" onClick={handleZoomIn} title="Zoom In">+</button>
                    <button className="btn btn-icon" onClick={handleZoomOut} title="Zoom Out">-</button>
                    <button className="btn btn-icon" onClick={handleZoomFit} title="Fit All">[ ]</button>
                </div>
            </div>
            <div className="waveform-content">
                {/* Signal name labels */}
                <div className="signal-names" ref={signalNamesRef} onScroll={handleNamesScroll}>
                    {/* Spacer to align with canvas header + timeline */}
                    <div
                        className="signal-names-header"
                        style={{ height: HEADER_HEIGHT + TIMELINE_HEIGHT }}
                    />
                    {/* Top padding to substitute scrolled-out items */}
                    <div style={{ height: paddingTop }} />
                    {visibleNamesData.map(({ sigIdx, rowIdx }) => {
                        const sig = state.signals[sigIdx];
                        if (!sig) return null;
                        const info = displayMap?.get(sigIdx);
                        const displayName = info?.displayName ?? sig.name;
                        return (
                            <div
                                key={sigIdx}
                                className={`signal-name-row ${state.activeSignalIndex === sigIdx ? 'active' : ''}`}
                                onClick={() => dispatch({ type: 'SET_ACTIVE_SIGNAL', index: sigIdx })}
                                onMouseEnter={(e) => handleSignalMouseEnter(e, sigIdx)}
                                onMouseLeave={handleSignalMouseLeave}
                            >
                                <div
                                    className="signal-color-bar"
                                    style={{ backgroundColor: getSignalColor(rowIdx) }}
                                />
                                <span className="signal-name-text">
                                    {displayName}
                                    {sig.width > 1 && ` [${sig.msb ?? sig.width - 1}:${sig.lsb ?? 0}]`}
                                </span>
                                <button
                                    className="signal-remove"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        dispatch({ type: 'REMOVE_SIGNAL', index: sigIdx });
                                        if (state.activeSignalIndex === sigIdx) {
                                            dispatch({ type: 'SET_ACTIVE_SIGNAL', index: null });
                                        }
                                    }}
                                    title="Remove signal"
                                >
                                    &#10005;
                                </button>
                            </div>
                        );
                    })}
                    {/* Bottom padding to substitute unloaded items */}
                </div>

                {/* Signal name tooltip */}
                {tooltip.visible && (
                    <div
                        className="signal-tooltip"
                        style={{
                            left: tooltip.x,
                            top: tooltip.y,
                            transform: 'translateY(-50%)',
                        }}
                    >
                        {tooltip.lines.map((segment, i) => (
                            <span key={i}>
                                {i > 0 && <span className="tooltip-separator">{' > '}</span>}
                                <span className={i === tooltip.lines.length - 1 ? 'tooltip-name' : 'tooltip-path'}>
                                    {segment}
                                </span>
                            </span>
                        ))}
                    </div>
                )}

                {/* Waveform canvas */}
                <div
                    ref={containerRef}
                    className="waveform-canvas-container"
                    onMouseDown={handleMouseDown}
                    onScroll={handleCanvasScroll}
                    style={{ cursor: 'grab' }}
                >
                    <div style={{ height: totalHeight, position: 'relative' }}>
                        <canvas ref={canvasRef} style={{ display: 'block', position: 'sticky', top: 0, left: 0 }} />
                    </div>
                </div>
            </div>
        </div>
    );
}
