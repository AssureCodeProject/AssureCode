import { useState, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell } from 'lucide-react';

import { callApi } from '../utils/api';
import { GlassCard } from './ui/GlassCard';

const POLL_MS = 20_000;

/**
 * ClientNotifications — bell icon + dropdown reading GET /api/notifications
 * (V024's `notifications` table). The only writer today is
 * apps/settlement-worker/src/worker.ts, reacting to a freelancer's
 * accept/reject decision and to repository provisioning completing. Polling,
 * not a WebSocket: this app already has two polling conventions
 * (RepoWorkspaceCard's recursive setTimeout, EscrowSettlementView's
 * setInterval) and no general-purpose notification stream to tap, so a third,
 * simple poll is the smallest addition consistent with what's already here.
 */
export function ClientNotifications() {
  const [notifications, setNotifications] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  const load = () => {
    callApi('/api/notifications')
      .then((data) => setNotifications(data.notifications || []))
      .catch(() => {
        /* Silent — a failed notification poll must not disrupt the dashboard. */
      });
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const unreadCount = notifications.filter((n) => !n.readAt).length;

  const handleOpen = () => {
    setIsOpen((v) => !v);
    // Mark visible unread notifications read on open, not on load — a
    // notification the client hasn't actually looked at yet should still
    // count toward the badge.
    notifications
      .filter((n) => !n.readAt)
      .forEach((n) => {
        callApi(`/api/notifications/${n.notificationId}/read`, 'PATCH').catch(() => undefined);
      });
    setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() })));
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={handleOpen}
        className="relative flex items-center gap-1.5 px-2.5 py-1 font-mono text-xs text-prose-muted hover:text-prose border border-rule hover:border-rule-hi transition-colors"
        aria-label="Notifications"
      >
        <Bell className="w-3.5 h-3.5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-fail text-ink text-[9px] font-bold">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 mt-2 w-80 z-50"
          >
            <GlassCard className="max-h-96 overflow-y-auto">
              <div className="p-3 border-b border-rule font-mono text-xs text-prose-muted uppercase tracking-wider">
                Notifications
              </div>
              {notifications.length === 0 && (
                <div className="p-4 font-mono text-xs text-prose-muted text-center">No notifications yet.</div>
              )}
              {notifications.map((n) => (
                <div key={n.notificationId} className="p-3 border-b border-rule last:border-b-0 font-mono text-[11px] text-prose">
                  <div className="text-prose-dim mb-1">{new Date(n.createdAt).toLocaleString()}</div>
                  <div>{n.message}</div>
                </div>
              ))}
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default ClientNotifications;
