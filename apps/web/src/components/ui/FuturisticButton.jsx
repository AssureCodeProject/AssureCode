import React from 'react';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';

export function FuturisticButton({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconPosition = 'left',
  loading = false,
  loadingText,
  fullWidth = false,
  disabled = false,
  children,
  className = '',
  ...props
}) {
  const isDisabled = disabled || loading;

  let variantClasses = 'bg-signal text-ink font-mono font-bold hover:opacity-90';
  if (variant === 'secondary') {
    variantClasses = 'bg-ink-3 text-prose border border-rule hover:border-rule-hi font-mono';
  } else if (variant === 'outline') {
    variantClasses = 'bg-transparent border border-signal text-signal hover:bg-signal/10 font-mono';
  } else if (variant === 'danger') {
    variantClasses = 'bg-fail/20 border border-fail/50 text-fail hover:bg-fail/30 font-mono';
  } else if (variant === 'ghost') {
    variantClasses = 'bg-transparent text-prose-muted hover:text-prose hover:bg-ink-3 font-mono';
  }

  let sizeClasses = 'px-4 py-2.5 text-xs';
  let iconSize = 'w-3.5 h-3.5';

  if (size === 'sm') {
    sizeClasses = 'px-3 py-1.5 text-[11px]';
    iconSize = 'w-3 h-3';
  } else if (size === 'lg') {
    sizeClasses = 'px-6 py-3.5 text-sm';
    iconSize = 'w-4 h-4';
  }

  const disabledClasses = isDisabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : 'cursor-pointer';
  const widthClasses = fullWidth ? 'w-full flex justify-center' : 'inline-flex';

  return (
    <motion.button
      whileTap={{ scale: isDisabled ? 1 : 0.98 }}
      transition={{ duration: 0.1 }}
      disabled={isDisabled}
      className={`items-center gap-2 tracking-wider transition-colors relative ${variantClasses} ${sizeClasses} ${disabledClasses} ${widthClasses} ${className}`}
      {...props}
    >
      {loading ? (
        <>
          <Loader2 className={`${iconSize} animate-spin shrink-0`} />
          {loadingText ? <span>{loadingText}</span> : children}
        </>
      ) : (
        <>
          {Icon && iconPosition === 'left' && <Icon className={`${iconSize} shrink-0`} />}
          {children && <span>{children}</span>}
          {Icon && iconPosition === 'right' && <Icon className={`${iconSize} shrink-0`} />}
        </>
      )}
    </motion.button>
  );
}

export const Button = FuturisticButton;
export default FuturisticButton;

