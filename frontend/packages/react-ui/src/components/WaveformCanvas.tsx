import {
    useRef,
    useEffect,
    useCallback,
    useMemo,
    useState,
} from 'react';
import { useAppContext } from '../hooks/useAppContext.tsx';
import { unflattenChisel, buildSignalDisplayMap } from '@waveform-viewer/core';
import type { SignalQueryResult, SignalDisplayInfo, FormatPlugin, FormatView } from '@waveform-viewer/core';


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
    if (val === 'g') return -3; // glitch
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
    const { state, dispatch, waveformService } = useAppContext();
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

        const viewStart = state.viewStart;
        const viewEnd = state.viewEnd;
        const viewRange = viewEnd - viewStart;
        if (viewRange <= 0) return;

        const timeToX = (t: number) => ((t - viewStart) / viewRange) * w;
        const timelineY = HEADER_HEIGHT;

        // ── Draw background for stale data areas ──
        if (state.queryResult) {
            const resultBegin = state.queryResult.tBegin;
            const resultEnd = state.queryResult.tEnd;

            // Compute pixel coordinates of areas outside the current query result
            let leftX = 0;
            let leftW = 0;
            let rightX = 0;
            let rightW = 0;

            if (viewStart < resultBegin) {
                leftW = timeToX(Math.min(resultBegin, viewEnd));
            }
            if (viewEnd > resultEnd) {
                rightX = timeToX(Math.max(resultEnd, viewStart));
                rightW = w - rightX;
            }

            // Draw slanted stripes for "stale" or "loading" areas
            if (leftW > 0 || rightW > 0) {
                ctx.save();
                ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
                ctx.lineWidth = 4;
                ctx.beginPath();
                if (leftW > 0) ctx.rect(leftX, timelineY + TIMELINE_HEIGHT, leftW, h - (timelineY + TIMELINE_HEIGHT));
                if (rightW > 0) ctx.rect(rightX, timelineY + TIMELINE_HEIGHT, rightW, h - (timelineY + TIMELINE_HEIGHT));
                ctx.clip();

                // Draw stripes across the whole canvas, relying on clip
                for (let i = -h; i < w; i += 20) {
                    ctx.beginPath();
                    ctx.moveTo(i, h);
                    ctx.lineTo(i + h, 0);
                    ctx.stroke();
                }
                ctx.restore();
            }
        }

        // Clear only behind the waveform area (if not drawing stripes everywhere)
        // (Handled by the initial clear and the stripes rendering above)

        // ── Draw timeline axis ────────────────────────────────────
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
        ctx.strokeStyle = color;

        const transitions = result.transitions;
        const numTransitions = transitions.length;
        const viewStart = state.viewStart;

        // Path batching: 
        // We accumulate all horizontal segments of the same bit value into one path.
        // Then we draw all vertical transitions in another path.

        // 1. Draw horizontal paths (High, Low, X, Z)
        // High/Low/X/Z can be batched separately if they have different colors/styles.
        // For simplicity, we start with High and Low which share the same color.

        let currentVal = result.initialValue;
        let segmentStartX = timeToX(viewStart);

        // We use separate paths for bit 0, bit 1, unknown (X), and High-Z (Z)
        const path0 = new Path2D();
        const path1 = new Path2D();
        const pathX = new Path2D();
        const pathZ = new Path2D();
        const pathG = new Path2D();

        const addSegment = (val: string, fromX: number, toX: number) => {
            const f = Math.max(fromX, 0);
            const t = Math.min(toX, canvasWidth);
            if (f >= t) return;

            const bit = parseBitValue(val);
            if (bit === 1) {
                path1.moveTo(f, rowTop);
                path1.lineTo(t, rowTop);
            } else if (bit === 0) {
                path0.moveTo(f, rowBot);
                path0.lineTo(t, rowBot);
            } else if (bit === -1) {
                pathX.moveTo(f, rowMid);
                pathX.lineTo(t, rowMid);
                // X - fill hatched red separately or handled later
            } else if (bit === -2) {
                pathZ.moveTo(f, rowMid);
                pathZ.lineTo(t, rowMid);
            } else if (bit === -3) {
                pathG.rect(f, rowTop, t - f, rowBot - rowTop);
            }
        };


        for (let i = 0; i < numTransitions; i++) {
            const [ts, val] = transitions[i];
            if (val === currentVal) continue; // Coalesce identical values

            const nextX = timeToX(ts);
            addSegment(currentVal, segmentStartX, nextX);
            currentVal = val;
            segmentStartX = nextX;
        }
        addSegment(currentVal, segmentStartX, timeToX(viewEnd));

        // 2. Stroke the batched paths
        ctx.setLineDash([]);
        ctx.strokeStyle = color;
        ctx.stroke(path0);
        ctx.stroke(path1);

        // X processing (Red hatched)
        ctx.strokeStyle = '#f44747';
        ctx.stroke(pathX);
        // Note: For X/Z we might still want to fill. Batched fill is harder with disjoint rects.
        // But we can use Path2D to batch lines.

        // Z processing (Dashed)
        ctx.setLineDash([4, 4]);
        ctx.stroke(pathZ);
        ctx.setLineDash([]);

        // Glitch processing (Solid block)
        ctx.fillStyle = 'rgba(120, 120, 120, 0.4)';
        ctx.fill(pathG);

        // 3. Draw transitions (vertical edges)
        const pathTrans = new Path2D();
        let prevVal = result.initialValue;
        for (let i = 0; i < numTransitions; i++) {
            const [ts, val] = transitions[i];
            if (val === prevVal) continue; // No vertical line if value hasn't changed

            const x = timeToX(ts);

            if (x >= 0 && x <= canvasWidth) {
                const b1 = parseBitValue(prevVal);
                const b2 = parseBitValue(val);

                if (b1 !== -3 && b2 !== -3) {
                    const y1 = b1 === 1 ? rowTop : b1 === 0 ? rowBot : rowMid;
                    const y2 = b2 === 1 ? rowTop : b2 === 0 ? rowBot : rowMid;
                    pathTrans.moveTo(x, y1);
                    pathTrans.lineTo(x, y2);
                } else if (b1 === -3 && b2 !== -3) {
                    // Transition exit from glitch
                    const y2 = b2 === 1 ? rowTop : b2 === 0 ? rowBot : rowMid;
                    pathTrans.moveTo(x, rowTop);
                    pathTrans.lineTo(x, rowBot);
                } else if (b1 !== -3 && b2 === -3) {
                    // Transition entry to glitch
                    pathTrans.moveTo(x, rowTop);
                    pathTrans.lineTo(x, rowBot);
                }
            }
            prevVal = val;
        }
        ctx.strokeStyle = color;
        ctx.stroke(pathTrans);
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

        const transitions = result.transitions;
        const numTransitions = transitions.length;
        const viewStart = state.viewStart;
        const slant = 4;

        const pathNormal = new Path2D();
        const pathX = new Path2D();
        const pathZ = new Path2D();
        const pathG = new Path2D();

        const formatter = formatView?.format || ((val: string, w: number) => {
            let r = val;
            if (r === 'GLITCH') return { display: 'GLITCH', isX: false, isZ: false, isG: true };
            if (r.startsWith('b') || r.startsWith('B')) r = r.slice(1);
            const isX = r.includes('x') || r.includes('X') || r.includes('u');
            const isZ = r.includes('z') || r.includes('Z');
            if (isX) return { display: 'X', isX: true, isZ: false, isG: false };
            if (isZ) return { display: 'Z', isX: false, isZ: true, isG: false };
            try {
                const bigValue = BigInt('0b' + r.padStart(w, '0'));
                return { display: '0x' + bigValue.toString(16).toUpperCase(), isX: false, isZ: false, isG: false };
            } catch {
                return { display: r, isX: false, isZ: false, isG: false };
            }
        });

        // We collect segments to draw text LATER, after backgrounds are batched.
        // But to keep it zero-allocation, we can just do a second pass if needed, 
        // OR just do text in the same pass if it's not too expensive.
        // Given we want max speed, let's batch backgrounds first.

        let currentVal = result.initialValue;
        let segmentStartX = timeToX(viewStart);

        const addDiamond = (val: string, fromX: number, toX: number) => {
            const f = Math.max(fromX, -slant);
            const t = Math.min(toX, canvasWidth + slant);
            if (f >= t) return;

            // --- FAST PATH: Identify segment type without BigInt/Formatting ---
            let type: 'g' | 'x' | 'z' | 'n' = 'n';
            if (val === 'GLITCH') {
                type = 'g';
            } else {
                for (let i = 0; i < val.length; i++) {
                    const c = val[i];
                    if (c === 'x' || c === 'X' || c === 'u' || c === 'U') {
                        type = 'x';
                        break;
                    }
                    if (c === 'z' || c === 'Z') {
                        type = 'z';
                        break;
                    }
                }
            }

            if (type === 'g') {
                pathG.rect(f, rowTop, t - f, rowBot - rowTop);
            } else {
                const p = type === 'x' ? pathX : type === 'z' ? pathZ : pathNormal;
                const midY = (rowTop + rowBot) / 2;
                p.moveTo(f + slant, rowTop);
                p.lineTo(t - slant, rowTop);
                p.lineTo(t, midY);
                p.lineTo(t - slant, rowBot);
                p.lineTo(f + slant, rowBot);
                p.lineTo(f, midY);
                p.closePath();
            }

        };


        for (let i = 0; i < numTransitions; i++) {
            const [ts, val] = transitions[i];
            if (val === currentVal) continue; // Coalesce identical values

            const nextX = timeToX(ts);
            addDiamond(currentVal, segmentStartX, nextX);
            currentVal = val;
            segmentStartX = nextX;
        }
        addDiamond(currentVal, segmentStartX, timeToX(viewEnd));

        // Stroke and Fill Normal
        ctx.fillStyle = color + '18';
        ctx.strokeStyle = color;
        ctx.fill(pathNormal);
        ctx.stroke(pathNormal);

        // Stroke and Fill X
        ctx.fillStyle = 'rgba(244, 71, 71, 0.15)';
        ctx.strokeStyle = '#f44747';
        ctx.fill(pathX);
        ctx.stroke(pathX);

        // Stroke and Fill Z
        ctx.fillStyle = 'rgba(220, 220, 170, 0.1)';
        ctx.strokeStyle = '#dcdcaa';
        ctx.fill(pathZ);
        ctx.stroke(pathZ);

        // Stroke and Fill Glitch
        ctx.fillStyle = 'rgba(150, 150, 150, 0.5)';
        ctx.strokeStyle = '#888888';
        ctx.fill(pathG);
        ctx.stroke(pathG);

        // TEXT PASS (Coalesced)
        ctx.fillStyle = color;
        ctx.font = '14px "Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        currentVal = result.initialValue;
        segmentStartX = timeToX(viewStart);

        for (let i = 0; i <= numTransitions; i++) {
            const [ts, val] = i < numTransitions ? transitions[i] : [viewEnd, ''];

            // Wait until value changes or end of view to draw text
            if (i < numTransitions && val === currentVal) continue;

            const nextX = i < numTransitions ? timeToX(ts) : timeToX(viewEnd);
            const f = Math.max(segmentStartX, 0);
            const t = Math.min(nextX, canvasWidth);
            const segWidth = t - f;

            if (segWidth > 40) {
                const parsed = formatter(currentVal, width);
                const textX = (f + t) / 2;
                const textY = (rowTop + rowBot) / 2;

                ctx.save();
                ctx.beginPath();
                ctx.rect(f + slant + 2, rowTop, segWidth - 2 * slant - 4, rowBot - rowTop);
                ctx.clip();
                ctx.fillText(parsed.display, textX, textY);
                ctx.restore();
            }

            if (i < numTransitions) {
                currentVal = val;
                segmentStartX = nextX;
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
                        Open a waveform file to view waveforms
                    </div>
                    <div className="empty-state-hint">
                        Click "Open Waveform File" in the title bar
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
                <div className="time-jump-controls" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className="time-info" style={{ marginRight: '4px' }}>View:</span>
                    <input
                        type="number"
                        className="time-input"
                        title="Start Time"
                        value={state.viewStart}
                        onChange={(e) => {
                            const val = Number(e.target.value);
                            if (!isNaN(val)) dispatch({ type: 'SET_VIEW', start: val, end: state.viewEnd });
                        }}
                        style={{ width: '80px', padding: '2px 4px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: '3px' }}
                    />
                    <span>-</span>
                    <input
                        type="number"
                        className="time-input"
                        title="End Time"
                        value={state.viewEnd}
                        onChange={(e) => {
                            const val = Number(e.target.value);
                            if (!isNaN(val)) dispatch({ type: 'SET_VIEW', start: state.viewStart, end: val });
                        }}
                        style={{ width: '80px', padding: '2px 4px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: '3px' }}
                    />
                    <span className="time-unit" style={{ marginRight: '8px', color: 'var(--text-muted)' }}>{unit}</span>
                    <button
                        className="btn btn-icon"
                        title="Force Refresh Data"
                        onClick={() => {
                            if (typeof waveformService.clearCache === 'function') {
                                waveformService.clearCache();
                            }
                            dispatch({ type: 'FORCE_REFRESH' });
                        }}
                    >
                        &#x21bb;
                    </button>
                </div>

                {state.activeSignalIndex !== null && state.signals[state.activeSignalIndex] && state.signals[state.activeSignalIndex].width > 1 && (
                    <div className="active-signal-format">
                        <span className="format-label" style={{ marginRight: '8px', color: 'var(--text-muted)' }}>Format ({state.signals[state.activeSignalIndex].name}):</span>
                        <select
                            className="signal-format"
                            value={state.signalFormats[state.activeSignalIndex] || 'Hex'}
                            onChange={(e) => dispatch({ type: 'SET_SIGNAL_FORMAT', index: state.activeSignalIndex!, format: e.target.value })}
                            title="Format"
                        >
                            {state.formatPlugins.map((plugin: FormatPlugin) => {
                                const activeSig = state.signals[state.activeSignalIndex!];
                                const validViews = plugin.views.filter((v: FormatView) => v.supportedWidths === 'any' || v.supportedWidths.includes(activeSig.width));
                                if (validViews.length === 0) return null;
                                return (
                                    <optgroup key={plugin.id} label={plugin.name}>
                                        {validViews.map((v: FormatView) => (
                                            <option key={v.id} value={v.id}>{v.name}</option>
                                        ))}
                                    </optgroup>
                                );
                            })}
                        </select>
                    </div>
                )}

                <div className="zoom-controls" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div className="lod-control" style={{ display: 'flex', alignItems: 'center', gap: '4px', marginRight: '8px' }}>
                        <span style={{ fontSize: '12px', opacity: 0.7, whiteSpace: 'nowrap' }}>LOD:</span>
                        <input
                            type="range"
                            min="1"
                            max="5"
                            step="0.5"
                            value={state.lodPixelFactor}
                            onChange={(e) => dispatch({ type: 'SET_LOD_FACTOR', factor: parseFloat(e.target.value) })}
                            style={{ width: '60px', height: '14px', margin: 0, padding: 0 }}
                            title="LOD Detail (Higher = more aggregation)"
                        />
                        <span style={{ fontSize: '11px', minWidth: '24px', opacity: 0.8 }}>{state.lodPixelFactor.toFixed(1)}x</span>
                    </div>
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
