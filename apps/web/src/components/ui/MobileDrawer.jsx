import React, { useEffect } from 'react';
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
}) {
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
          >
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

