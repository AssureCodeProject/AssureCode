import React from 'react';
import { motion } from 'framer-motion';

export function RadialGauge({
  value,
  max = 100,
  size = 180,
  strokeWidth = 12,
  label,
  colorMode = 'auto',
  showValue = true,
  animated = true,
  centerContent,
  className = '',
}) {
  const percentage = Math.min(Math.max((value / max) * 100, 0), 100);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  // Determine stroke color based on colorMode or value auto-thresholds
  let strokeColor = '#00D4FF'; // cyan default
  let dropShadowColor = 'rgba(0, 212, 255, 0.5)';

  if (colorMode === 'auto') {
    if (percentage >= 80) {
      strokeColor = '#00FF88'; // green
      dropShadowColor = 'rgba(0, 255, 136, 0.6)';
    } else if (percentage >= 60) {
      strokeColor = '#FFB800'; // yellow
      dropShadowColor = 'rgba(255, 184, 0, 0.6)';
    } else {
      strokeColor = '#FF3366'; // red
      dropShadowColor = 'rgba(255, 51, 102, 0.6)';
    }
  } else if (colorMode === 'green') {
    strokeColor = '#00FF88';
    dropShadowColor = 'rgba(0, 255, 136, 0.6)';
  } else if (colorMode === 'yellow') {
    strokeColor = '#FFB800';
    dropShadowColor = 'rgba(255, 184, 0, 0.6)';
  } else if (colorMode === 'red') {
    strokeColor = '#FF3366';
    dropShadowColor = 'rgba(255, 51, 102, 0.6)';
  } else if (colorMode === 'purple') {
    strokeColor = '#9333FF';
    dropShadowColor = 'rgba(147, 51, 255, 0.6)';
  } else if (colorMode === 'gradient') {
    strokeColor = 'url(#gauge-gradient)';
    dropShadowColor = 'rgba(0, 212, 255, 0.5)';
  }

  const gradientId = `gauge-grad-${Math.random().toString(36).substring(2, 11)}`;

  return (
    <div
      className={`relative inline-flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="transform -rotate-90">
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#00D4FF" />
            <stop offset="100%" stopColor="#9333FF" />
          </linearGradient>
          <filter id={`glow-${gradientId}`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        {/* Track circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="rgba(255, 255, 255, 0.06)"
          strokeWidth={strokeWidth}
          fill="none"
        />

        {/* Progress circle */}
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={colorMode === 'gradient' ? `url(#${gradientId})` : strokeColor}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: animated ? circumference : strokeDashoffset }}
          animate={{ strokeDashoffset }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
          strokeLinecap="round"
          fill="none"
          style={{
            filter: `drop-shadow(0px 0px 6px ${dropShadowColor})`,
          }}
        />
      </svg>

      {/* Central content */}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {centerContent ? (
          centerContent
        ) : (
          <>
            {showValue && (
              <span className="text-3xl font-extrabold font-mono tracking-tight text-white drop-shadow-md">
                {Math.round(value)}
              </span>
            )}
            {label && (
              <span className="text-[11px] font-mono uppercase tracking-wider text-gray-400 mt-0.5">
                {label}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export const Gauge = RadialGauge;
export default RadialGauge;
