import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

export function StatusBadge({
  variant = 'signal',
  size = 'md',
  icon: Icon,
  animated = false,
  mono = true,
  copyable = false,
  copyText,
  onCopy,
  children,
  className = '',
}) {
  const [copied, setCopied] = useState(false);

  let variantStyles = 'bg-ink border border-rule text-signal';
  let dotColor = 'bg-signal';

  if (variant === 'danger' || variant === 'fail') {
    variantStyles = 'bg-ink border border-rule text-fail';
    dotColor = 'bg-fail';
  } else if (variant === 'warning' || variant === 'warn') {
    variantStyles = 'bg-ink border border-rule text-warn';
    dotColor = 'bg-warn';
  } else if (variant === 'neutral') {
    variantStyles = 'bg-ink border border-rule text-prose-muted';
    dotColor = 'bg-prose-dim';
  }

  let sizeStyles = 'px-2.5 py-0.5 text-xs';
  let iconSize = 'w-3.5 h-3.5';
  let dotSize = 'w-1.5 h-1.5';

  if (size === 'sm') {
    sizeStyles = 'px-2 py-0.5 text-[11px]';
    iconSize = 'w-3 h-3';
    dotSize = 'w-1 h-1';
  }

  const handleCopy = (e) => {
    e.stopPropagation();
    const textToCopy = copyText || (typeof children === 'string' ? children : '');
    if (!textToCopy) return;

    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    if (onCopy) onCopy();

    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono font-semibold transition-colors ${
        mono ? 'font-mono' : ''
      } ${variantStyles} ${sizeStyles} ${
        copyable ? 'cursor-pointer hover:border-rule-hi' : ''
      } ${className}`}
      onClick={copyable ? handleCopy : undefined}
      title={copyable ? 'Click to copy' : undefined}
    >
      {animated && (
        <span className={`rounded-full ${dotColor} ${dotSize} animate-data-tick`} />
      )}
      {Icon && <Icon className={`${iconSize} shrink-0`} />}
      {children}
      {copyable && (
        <span className="ml-1 text-prose-muted hover:text-prose">
          {copied ? (
            <Check className={`${iconSize} text-signal`} />
          ) : (
            <Copy className={iconSize} />
          )}
        </span>
      )}
    </span>
  );
}

export const Badge = StatusBadge;
export default StatusBadge;

