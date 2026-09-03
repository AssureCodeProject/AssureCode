import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

export function MobileDrawer({
  isOpen,
  onClose,
  title,
  subtitle,
  position = 'right',
  children,
  footer,
  className = '',
  // Opt-in: only a caller that passes `resizable` gets a drag handle. Every
  // other MobileDrawer user (the escrow dispute drawer, KYC modal, etc.) is
  // unaffected — this is additive to the one shared drawer primitive, not a
  // behavior change for drawers that never asked for it.
  resizable = false,
  minWidth = 360,
  maxWidthVw = 68,
  defaultWidth = 384, // matches the existing `sm:w-96` default below
}) {
  const canResize = resizable && position === 'right';
  const [width, setWidth] = useState(defaultWidth);
  const isResizingRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Pointer Events cover mouse and touch through the same handlers, so
  // dragging the handle works identically with a mouse or a finger.
  useEffect(() => {
    if (!canResize) return undefined;

    const handlePointerMove = (e) => {
      if (!isResizingRef.current) return;
      const maxPx = window.innerWidth * (maxWidthVw / 100);
      // The panel is right-aligned, so its width is the distance from the
      // cursor to the right edge of the viewport: dragging left grows it,
      // dragging right shrinks it.
      const next = Math.min(Math.max(window.innerWidth - e.clientX, minWidth), maxPx);
      setWidth(next);
    };
    const stopResize = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
    };
  }, [canResize, minWidth, maxWidthVw]);

  const startResize = (e) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  };

  let panelVariants = {
    initial: { x: '100%' },
    animate: { x: 0 },
    exit: { x: '100%' },
  };

  let positionClasses = 'top-0 right-0 h-full w-full sm:w-96 border-l border-rule';

  if (position === 'left') {
    panelVariants = {
      initial: { x: '-100%' },
      animate: { x: 0 },
      exit: { x: '-100%' },
    };
    positionClasses = 'top-0 left-0 h-full w-full sm:w-96 border-r border-rule';
  } else if (position === 'bottom') {
    panelVariants = {
      initial: { y: '100%' },
      animate: { y: 0 },
      exit: { y: '100%' },
    };
    positionClasses = 'bottom-0 left-0 right-0 max-h-[85vh] border-t border-rule';
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 overflow-hidden font-sans">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="fixed inset-0 bg-ink/80"
          />

          {/* Drawer Panel */}
          <motion.div
            initial={panelVariants.initial}
            animate={panelVariants.animate}
            exit={panelVariants.exit}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className={`fixed bg-ink-2 flex flex-col z-50 ${positionClasses} ${className}`}
            // maxWidth caps at the viewport so a small screen never overflows
            // even if `width` state is still holding a larger desktop value.
            style={canResize ? { width: `${width}px`, maxWidth: '100vw' } : undefined}
          >
            {/* Resize handle — left edge, since the panel opens from the right. */}
            {canResize && (
              <div
                onPointerDown={startResize}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize contract details panel"
                className="absolute top-0 left-0 h-full w-2 -translate-x-1/2 cursor-ew-resize z-10 group touch-none"
              >
                <div className="h-full w-full mx-auto max-w-[3px] group-hover:bg-signal/50 group-active:bg-signal/70 transition-colors" />
              </div>
            )}

            {/* Header */}
            <div className="p-5 border-b border-rule flex items-center justify-between font-mono">
              <div>
                {title && <h3 className="text-sm font-bold text-prose tracking-wider uppercase">{title}</h3>}
                {subtitle && <p className="text-xs text-prose-muted mt-0.5">{subtitle}</p>}
              </div>
              <button
                onClick={onClose}
                className="p-1.5 text-prose-muted hover:text-prose hover:bg-ink-3 transition-colors border border-rule"
                aria-label="Close drawer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-5">{children}</div>

            {/* Footer */}
            {footer && (
              <div className="p-5 border-t border-rule bg-ink font-mono text-xs">{footer}</div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export const Drawer = MobileDrawer;
export default MobileDrawer;

