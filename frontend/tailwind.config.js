/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      /* xs: phones below 375px stack the history ledger's status +
         recorded lines (see history-ledger__cell--status/--date).
         Measured floor for sharing one line: status cell needs ~103px
         (24 tile + 8 gap + "Convergence" at text-xs medium = 71px) plus
         the 16px column gap and the 180px UTC stamp, so the two-column
         pair needs a ~364px layout width; 375px (iPhone SE/8, overlay
         scrollbars) keeps ~11px of slack. A desktop window with a
         classic scrollbar needs ~380px outer width for the pair. */
      screens: {
        xs: "375px",
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        success: "hsl(var(--success))",
        caution: "hsl(var(--caution))",
        /* Night chrome — the only dark surface (lunar spine, mobile bars). */
        night: {
          DEFAULT: "hsl(var(--night))",
          foreground: "hsl(var(--moonlight))",
          muted: "hsl(var(--night-muted))",
        },
        "caution-night": "hsl(var(--caution-night))",
        "destructive-night": "hsl(var(--destructive-night))",
        "success-night": "hsl(var(--success-night))",
        // 16Personalities group colors (fixed by the product spec).
        group: {
          analysts: "#88619a",
          diplomats: "#33a474",
          sentinels: "#4298b4",
          explorers: "#e4ae3a",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        display: ["Fraunces Variable", "Georgia", "serif"],
        sans: [
          "IBM Plex Sans Variable",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "moon-glow": {
          "0%, 100%": { filter: "drop-shadow(0 0 2px hsl(var(--primary) / 0.35))" },
          "50%": { filter: "drop-shadow(0 0 7px hsl(var(--primary) / 0.6))" },
        },
        "live-pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        "fade-in": "fade-in 240ms ease-out both",
        "moon-glow": "moon-glow 2.4s ease-in-out infinite",
        "live-pulse-dot": "live-pulse-dot 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
