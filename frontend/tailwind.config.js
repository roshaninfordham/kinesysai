/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        kinesys: {
          primary: "#6366f1",
          secondary: "#8b5cf6",
          accent: "#06b6d4",
          dark: "#0a0a0f",
          surface: "#111118",
          "surface-2": "#1a1a24",
          muted: "#23232f",
          fire: "#f05a28",
          cyan: "#00e5c8",
          indigo: "#8b6cef",
          border: "rgba(255,255,255,0.07)",
        },
      },
      fontFamily: {
        sans: ["Sora", "Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      boxShadow: {
        "glow-fire": "0 0 20px rgba(240,90,40,0.35), 0 0 60px rgba(240,90,40,0.10)",
        "glow-cyan": "0 0 20px rgba(0,229,200,0.35), 0 0 60px rgba(0,229,200,0.10)",
        "glow-indigo": "0 0 20px rgba(139,108,239,0.35), 0 0 60px rgba(139,108,239,0.10)",
      },
      keyframes: {
        "glow-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.6" },
        },
      },
      animation: {
        "glow-pulse": "glow-pulse 2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
