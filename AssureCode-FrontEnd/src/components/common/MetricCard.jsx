import React from 'react';

export function MetricCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  trendLabel,
  color = 'brand', // 'brand' | 'emerald' | 'cyan' | 'amber' | 'rose' | 'purple'
  badge,
  onClick
}) {
  const colorSchemes = {
    brand: {
      bg: 'bg-brand-500/10',
      border: 'border-brand-500/20 hover:border-brand-500/40',
      iconBg: 'bg-brand-500/20 text-indigo-400',
      valueColor: 'text-indigo-200',
      glow: 'hover:shadow-brand-500/10'
    },
    emerald: {
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/20 hover:border-emerald-500/40',
      iconBg: 'bg-emerald-500/20 text-emerald-400',
      valueColor: 'text-emerald-200',
      glow: 'hover:shadow-emerald-500/10'
    },
    cyan: {
      bg: 'bg-cyan-500/10',
      border: 'border-cyan-500/20 hover:border-cyan-500/40',
      iconBg: 'bg-cyan-500/20 text-cyan-400',
      valueColor: 'text-cyan-200',
      glow: 'hover:shadow-cyan-500/10'
    },
    amber: {
      bg: 'bg-amber-500/10',
      border: 'border-amber-500/20 hover:border-amber-500/40',
      iconBg: 'bg-amber-500/20 text-amber-400',
      valueColor: 'text-amber-200',
      glow: 'hover:shadow-amber-500/10'
    },
    rose: {
      bg: 'bg-rose-500/10',
      border: 'border-rose-500/20 hover:border-rose-500/40',
      iconBg: 'bg-rose-500/20 text-rose-400',
      valueColor: 'text-rose-200',
      glow: 'hover:shadow-rose-500/10'
    },
    purple: {
      bg: 'bg-purple-500/10',
      border: 'border-purple-500/20 hover:border-purple-500/40',
      iconBg: 'bg-purple-500/20 text-purple-400',
      valueColor: 'text-purple-200',
      glow: 'hover:shadow-purple-500/10'
    }
  };

  const scheme = colorSchemes[color] || colorSchemes.brand;

  return (
    <div
      onClick={onClick}
      className={`glass-panel rounded-xl p-5 border transition-all duration-300 ${scheme.border} ${scheme.glow} ${
        onClick ? 'cursor-pointer hover:-translate-y-1' : ''
      }`}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">{title}</p>
          <h4 className={`text-2xl font-bold font-mono ${scheme.valueColor}`}>{value}</h4>
        </div>
        {Icon && (
          <div className={`p-2.5 rounded-xl ${scheme.iconBg}`}>
            <Icon className="w-5 h-5" />
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
        {subtitle && <span>{subtitle}</span>}
        {badge && <div>{badge}</div>}
        {trend && (
          <span className={`flex items-center gap-1 font-medium ${trend > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {trend > 0 ? '↑' : '↓'} {Math.abs(trend)}% {trendLabel}
          </span>
        )}
      </div>
    </div>
  );
}
