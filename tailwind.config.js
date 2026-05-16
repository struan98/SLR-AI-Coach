/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Brand colors as named utilities (so we can use bg-brand-orange etc if we want)
        // The artifact files use hex directly, so this is just for convenience going forward.
        brand: {
          navy: "#0a2540",
          orange: "#ff7a3d",
        },
      },
    },
  },
  plugins: [],
};
