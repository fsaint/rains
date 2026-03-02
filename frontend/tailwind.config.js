/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Primary colors from brand guidelines
        'reins-navy': '#1a2332',
        'trust-blue': '#2563eb',
        'safe-green': '#059669',
        // Secondary colors
        'caution-amber': '#d97706',
        'alert-red': '#dc2626',
        // Backgrounds
        'surface-gray': '#f8fafc',
        'dark-base': '#0f172a',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
