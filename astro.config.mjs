// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

/** @type {import('vite').Plugin} */
const geojsonPlugin = {
  name: 'vite-plugin-geojson',
  transform(src, id) {
    if (id.endsWith('.geojson')) {
      // Parse to validate, then emit as a default ES module export.
      JSON.parse(src);
      return { code: `export default ${src}`, map: null };
    }
  },
};

// https://astro.build/config
export default defineConfig({
  site: 'https://digitizing-waste.github.io',
  integrations: [react()],
  vite: {
    plugins: [geojsonPlugin],
  },
});
