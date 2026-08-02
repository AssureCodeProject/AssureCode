/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['Geist', 'Inter', 'sans-serif'],
        heading: ['Geist', 'Inter', 'sans-serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      colors: {
        ink:    { DEFAULT: '#0E1116', 2: '#161A21', 3: '#1B2028' },
        rule:   { DEFAULT: '#1F242C', hi: '#2A3038' },
        prose:  { DEFAULT: '#E8EBF0', muted: '#9AA3B2', dim: '#6B7280' },
        signal: { DEFAULT: '#C2FF6E' },
        warn:   { DEFAULT: '#F5A524' },
        fail:   { DEFAULT: '#FF5C5C' },

        // Legacy compatibility mappings to prevent runtime errors during phase transition
        void: {
          400: '#161A21',
          700: '#161A21',
          800: '#0E1116',
          900: '#0E1116',
        },
        cyber: {
          300: '#E8EBF0',
          400: '#C2FF6E',
          500: '#C2FF6E',
          800: '#1F242C',
          900: '#161A21',
        },
        neon: {
          400: '#C2FF6E',
          500: '#C2FF6E',
          900: '#161A21',
        },
        status: {
          success: '#C2FF6E',
          warning: '#F5A524',
          danger:  '#FF5C5C',
        },
      },
      boxShadow: {
        'ledger': '0 1px 0 0 #1F242C',
      },
      animation: {
        'data-tick': 'dataTick 2s ease-in-out infinite',
      },
      keyframes: {
        dataTick: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
