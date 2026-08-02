import React from 'react';
import { motion } from 'framer-motion';

export function GlassCard({
  children,
  className = '',
  ...motionProps
}) {
  const combinedClasses = [
    'bg-ink-2 border border-rule transition-colors',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <motion.div className={combinedClasses} {...motionProps}>
      {children}
    </motion.div>
  );
}

export function CardHeader({ children, className = '', ...props }) {
  return (
    <div className={`p-6 border-b border-rule ${className}`} {...props}>
      {children}
    </div>
  );
}

export function CardTitle({ children, className = '', ...props }) {
  return (
    <h3 className={`text-lg font-bold text-prose font-display tracking-tight ${className}`} {...props}>
      {children}
    </h3>
  );
}

export function CardDescription({ children, className = '', ...props }) {
  return (
    <p className={`text-xs text-prose-muted mt-1 leading-relaxed ${className}`} {...props}>
      {children}
    </p>
  );
}

export function CardContent({ children, className = '', ...props }) {
  return (
    <div className={`p-6 ${className}`} {...props}>
      {children}
    </div>
  );
}

export function CardFooter({ children, className = '', ...props }) {
  return (
    <div className={`p-6 pt-0 border-t border-rule mt-4 flex items-center justify-between ${className}`} {...props}>
      {children}
    </div>
  );
}

GlassCard.Header = CardHeader;
GlassCard.Title = CardTitle;
GlassCard.Description = CardDescription;
GlassCard.Content = CardContent;
GlassCard.Footer = CardFooter;

export const Card = GlassCard;
export default GlassCard;

