import type {Config} from "tailwindcss";

/**
 * PONSHOT visual system.
 *
 * A near-black ground with one saturated green as the primary accent and a matching red
 * for the opposing side, so UP and DOWN read instantly at a glance and nothing else in
 * the interface competes with them for attention.
 */
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: {
          950: "#050607",
          900: "#0a0c0e",
          850: "#0e1113",
          800: "#121619",
          750: "#171b1f",
          700: "#1d2227",
          600: "#272d33",
          500: "#39414a",
        },
        mute: {500: "#6b7683", 400: "#8b95a1", 300: "#aab3bd", 200: "#d5dae0"},
        // The brand lime, taken from the PONSHOT mark: a vivid yellow-green, not the
        // blue-leaning green a generic "success" palette would give.
        up: {700: "#4f7d0a", 600: "#77b512", 500: "#9be81c", 400: "#b4f53f", 300: "#cdfa7a"},
        down: {600: "#a32833", 500: "#e33f4d", 400: "#ff5c69", 300: "#ff8f98"},
        gold: {500: "#f0b429", 400: "#f7c948"},
        // Burn: an ember orange, deliberately distinct from both `up` (lime) and `down`
        // (red). A burned round is neither a win nor a loss for a side, and colouring it
        // like either would misread at a glance.
        burn: {600: "#b8480d", 500: "#f4711f", 400: "#ff9248", 300: "#ffb27d"},
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        "glow-up": "0 0 26px -4px rgba(155, 232, 28, 0.5)",
        "glow-down": "0 0 24px -4px rgba(227, 63, 77, 0.45)",
        card: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.8)",
      },
      keyframes: {
        pulseRing: {
          "0%,100%": {opacity: "0.55"},
          "50%": {opacity: "1"},
        },
        riseIn: {
          from: {opacity: "0", transform: "translateY(6px)"},
          to: {opacity: "1", transform: "translateY(0)"},
        },
      },
      animation: {
        "pulse-ring": "pulseRing 2.4s ease-in-out infinite",
        "rise-in": "riseIn 220ms ease-out",
      },
    },
  },
  plugins: [],
} satisfies Config;
