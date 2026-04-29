import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#0b0f19",
        panel: "#111827",
        soft: "#f7f7f8"
      },
      boxShadow: {
        glow: "0 20px 80px rgba(31, 41, 55, 0.16)"
      }
    }
  },
  plugins: []
};

export default config;
