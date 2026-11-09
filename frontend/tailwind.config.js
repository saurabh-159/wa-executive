/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
    "./hooks/**/*.{js,jsx,ts,tsx}",
    "./lib/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        exec: {
          bg: "var(--theme-bg)",
          card: "var(--theme-surface)",
          line: "var(--theme-line)",
          saffron: "var(--theme-saffron)",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        serif: [
          "var(--font-newsreader)",
          "ui-serif",
          "Georgia",
          "Cambria",
          "Times New Roman",
          "Times",
          "serif",
        ],
      },
      boxShadow: {
        "glow-amber": "0 0 24px rgba(245, 158, 11, 0.18)",
        "glow-emerald": "0 0 24px rgba(16, 185, 129, 0.18)",
        "glow-saffron": "0 10px 28px color-mix(in srgb, var(--theme-saffron) 32%, transparent)",
        "glow-rose": "0 0 24px rgba(244, 63, 94, 0.18)",
      },
      animation: {
        "live-ping": "live-ping 1.8s cubic-bezier(0, 0, 0.2, 1) infinite",
        shimmer: "shimmer 1.6s linear infinite",
        "loading-bar": "loading-bar 1.1s ease-in-out infinite",
      },
      keyframes: {
        "live-ping": {
          "0%": { transform: "scale(1)", opacity: "0.75" },
          "80%, 100%": { transform: "scale(2.4)", opacity: "0" },
        },
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
        "loading-bar": {
          "0%": { transform: "translateX(-120%)" },
          "100%": { transform: "translateX(320%)" },
        },
      },
    },
  },
  plugins: [],
};
