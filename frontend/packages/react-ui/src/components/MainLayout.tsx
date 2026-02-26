import { useState, useCallback, useEffect, useRef } from 'react';
import { Sidebar } from './Sidebar.tsx';
import { WaveformCanvas } from './WaveformCanvas.tsx';

/**
 * MainLayout — encapsulates the resizable sidebar and waveform canvas.
 * This is used across all platforms (Web, VSCode, Tauri) to ensure
 * consistent layout behavior and performance optimizations.
 */
export function MainLayout() {
    const [sidebarWidth, setSidebarWidth] = useState(300);
    const [isResizing, setIsResizing] = useState(false);
    const layoutRef = useRef<HTMLDivElement>(null);
    const resizeRef = useRef<{ currentWidth: number; raf: number }>({ currentWidth: 300, raf: 0 });

    const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
        setIsResizing(true);
        resizeRef.current.currentWidth = sidebarWidth;
        e.preventDefault();
    }, [sidebarWidth]);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isResizing || !layoutRef.current) return;

            // Limit sidebar width between 150 and 800
            const newWidth = Math.max(150, Math.min(800, e.clientX));
            resizeRef.current.currentWidth = newWidth;

            // Use requestAnimationFrame for smooth DOM updates without React re-renders
            if (resizeRef.current.raf) cancelAnimationFrame(resizeRef.current.raf);
            resizeRef.current.raf = requestAnimationFrame(() => {
                if (layoutRef.current) {
                    layoutRef.current.style.setProperty('--sidebar-width', `${newWidth}px`);
                }
            });
        };

        const handleMouseUp = () => {
            if (!isResizing) return;
            setIsResizing(false);
            setSidebarWidth(resizeRef.current.currentWidth);
        };

        if (isResizing) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
        }
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            if (resizeRef.current.raf) cancelAnimationFrame(resizeRef.current.raf);
        };
    }, [isResizing]);

    return (
        <div
            ref={layoutRef}
            className="main-content"
            style={{
                '--sidebar-width': `${sidebarWidth}px`,
                display: 'flex',
                flex: 1,
                overflow: 'hidden'
            } as React.CSSProperties}
        >
            <Sidebar width={sidebarWidth} />
            <div
                className={`resize-handle ${isResizing ? 'active' : ''}`}
                onMouseDown={handleResizeMouseDown}
            />
            <WaveformCanvas />
        </div>
    );
}
