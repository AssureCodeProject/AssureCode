import React, { createContext, useContext, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';

const ToastContext = createContext(undefined);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (toast) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const newToast = { ...toast, id };
      setToasts((prev) => [...prev, newToast]);

      const duration = toast.duration ?? 4000;
      if (duration > 0) {
        setTimeout(() => {
          removeToast(id);
        }, duration);
      }

      return id;
    },
    [removeToast]
  );

  const success = useCallback(
    (title, description) => addToast({ type: 'success', title, description }),
    [addToast]
  );
  const error = useCallback(
    (title, description) => addToast({ type: 'error', title, description }),
    [addToast]
  );
  const warning = useCallback(
    (title, description) => addToast({ type: 'warning', title, description }),
    [addToast]
  );
  const info = useCallback(
    (title, description) => addToast({ type: 'info', title, description }),
    [addToast]
  );

  return (
    <ToastContext.Provider
      value={{ toasts, addToast, removeToast, success, error, warning, info }}
    >
      {children}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none px-4 font-mono text-xs">
        <AnimatePresence mode="sync">
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={removeToast} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

function ToastItem({ toast, onDismiss }) {
  let Icon = CheckCircle2;
  let iconColor = 'text-signal';

  if (toast.type === 'error') {
    Icon = XCircle;
    iconColor = 'text-fail';
  } else if (toast.type === 'warning') {
    Icon = AlertTriangle;
    iconColor = 'text-warn';
  } else if (toast.type === 'info') {
    Icon = Info;
    iconColor = 'text-signal';
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.15 }}
      className="pointer-events-auto bg-ink-2 p-4 border border-rule flex items-start gap-3 text-prose shadow-none"
    >
      <Icon className={`w-4 h-4 ${iconColor} shrink-0 mt-0.5`} />
      <div className="flex-1 min-w-0">
        <h4 className="font-bold text-prose">{toast.title}</h4>
        {toast.description && (
          <p className="text-prose-muted mt-0.5 font-sans text-xs">{toast.description}</p>
        )}
      </div>
      <button
        onClick={() => onDismiss(toast.id)}
        className="text-prose-muted hover:text-prose p-0.5"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </motion.div>
  );
}

export const ToastNotification = ToastItem;
export default ToastNotification;

