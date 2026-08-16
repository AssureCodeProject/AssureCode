import React from 'react';

export function Badge({ children, variant = 'default', size = 'sm', className = '', icon: Icon }) {
  const sizeClasses = {
    xs: 'px-1.5 py-0.5 text-[10px]',
    sm: 'px-2.5 py-1 text-xs',
    md: 'px-3 py-1.5 text-sm'
  };

  const variantClasses = {
    default: 'bg-slate-800/80 text-slate-300 border-slate-700/60',
    primary: 'bg-brand-500/15 text-indigo-300 border-brand-500/30 neon-border-brand',
    success: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 neon-border-emerald',
    warning: 'bg-amber-500/15 text-amber-300 border-amber-500/30 neon-border-amber',
    danger: 'bg-rose-500/15 text-rose-300 border-rose-500/30 neon-border-rose',
    cyan: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
    purple: 'bg-purple-500/15 text-purple-300 border-purple-500/30'
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-medium rounded-full border transition-all duration-200 ${sizeClasses[size]} ${variantClasses[variant]} ${className}`}
    >
      {Icon && <Icon className="w-3.5 h-3.5" />}
      {children}
    </span>
  );
}

export function StatusBadge({ status }) {
  const map = {
    INITIALIZING: { label: 'Initializing', variant: 'default' },
    MATCHING: { label: 'AI Matchmaking', variant: 'purple' },
    LOCKED: { label: 'Contract Locked', variant: 'primary' },
    CODE_PUSHED: { label: 'Code Pushed', variant: 'cyan' },
    CI_VERIFIED: { label: 'CI/CD Verified', variant: 'success' },
    SETTLED: { label: 'Escrow Settled', variant: 'success' },
    PASSED: { label: 'Passed', variant: 'success' },
    FAILED: { label: 'Failed', variant: 'danger' },
    CRITICAL: { label: 'Critical', variant: 'danger' },
    HIGH: { label: 'High', variant: 'danger' },
    MEDIUM: { label: 'Medium', variant: 'warning' },
    LOW: { label: 'Low', variant: 'cyan' },
    IN_PROGRESS: { label: 'In Progress', variant: 'warning' },
    VERIFIED: { label: 'Verified', variant: 'success' },
    HELD_IN_ESCROW: { label: 'Held in Escrow', variant: 'primary' },
    CAPTURED: { label: 'Captured', variant: 'success' }
  };

  const config = map[status] || { label: status, variant: 'default' };

  return <Badge variant={config.variant}>{config.label}</Badge>;
}
