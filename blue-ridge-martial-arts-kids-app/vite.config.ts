import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves a project site from /<repo-name>/, so the production
// build needs that prefix. Locally (and on any host that serves from the
// domain root) it must stay '/'. BASE_PATH lets the deploy workflow pass the
// repository name in without this file having to know it.
const base = process.env.BASE_PATH ?? '/'

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
