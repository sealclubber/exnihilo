import { defineConfig } from 'vite';

export default defineConfig({
  // Listen on every interface: the browser is usually on another machine.
  server: { host: true, port: 5173 },
  preview: { host: true, port: 5173 },
});
