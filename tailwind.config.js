/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      colors: {
        // Deep space dark palette
        void: {
          50:  '#E8EAFF',
          100: '#C4C8FF',
          200: '#1A1D3A',
          300: '#151830',
          400: '#101226',
          500: '#0B0D1E',
          600: '#080A18',
          700: '#050712',
          800: '#03040C',
          900: '#010208',
        },
        // Neon cyan accent
        cyber: {
          50:  '#E0FEFF',
          100: '#B3FCFF',
          200: '#67F0FF',
          300: '#33E8FF',
          400: '#00D4FF',
          500: '#00B8E6',
          600: '#0090B8',
          700: '#006B8A',
          800: '#00475C',
          900: '#00232E',
        },
        // Electric purple accent
        neon: {
          50:  '#F3E8FF',
          100: '#E4CCFF',
          200: '#C999FF',
          300: '#AE66FF',
          400: '#9333FF',
          500: '#7C1FFF',
          600: '#6B00F0',
          700: '#5500C0',
          800: '#3F0090',
          900: '#290060',
        },
        // Status colors (neon variants)
        status: {
          success:  '#00FF88',
          warning:  '#FFB800',
          danger:   '#FF3366',
          info:     '#00D4FF',
          scanning: '#FFB800',
        },
      },
      boxShadow: {
        'glass': '0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255,255,255,0.05)',
        'glass-hover': '0 12px 48px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255,255,255,0.08)',
        'glow-cyan': '0 0 30px rgba(0, 212, 255, 0.2), 0 0 60px rgba(0, 212, 255, 0.08)',
        'glow-purple': '0 0 30px rgba(147, 51, 255, 0.2), 0 0 60px rgba(147, 51, 255, 0.08)',
        'glow-green': '0 0 30px rgba(0, 255, 136, 0.2), 0 0 60px rgba(0, 255, 136, 0.08)',
        'glow-red': '0 0 30px rgba(255, 51, 102, 0.2), 0 0 60px rgba(255, 51, 102, 0.08)',
        'glow-yellow': '0 0 30px rgba(255, 184, 0, 0.2), 0 0 60px rgba(255, 184, 0, 0.08)',
        'neon-border': '0 0 10px rgba(0, 212, 255, 0.15), inset 0 0 10px rgba(0, 212, 255, 0.05)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'shimmer': 'shimmer 3s linear infinite',
        'float': 'float 6s ease-in-out infinite',
        'glow-pulse': 'glowPulse 2s ease-in-out infinite',
        'scan-line': 'scanLine 4s linear infinite',
        'border-flow': 'borderFlow 3s linear infinite',
        'fade-in-up': 'fadeInUp 0.6s ease-out forwards',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
        glowPulse: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
        scanLine: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        borderFlow: {
          '0%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
          '100%': { backgroundPosition: '0% 50%' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-mesh': 'linear-gradient(135deg, var(--tw-gradient-stops))',
      },
    },
  },
  plugins: [],
};
