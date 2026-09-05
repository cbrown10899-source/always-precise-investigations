import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { App } from './app/App'
import { StoreProvider } from './app/StoreProvider'
import { registerServiceWorker } from './utils/registerServiceWorker'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/features.css'

/**
 * HashRouter, not BrowserRouter.
 *
 * GitHub Pages serves static files and has no rewrite rule, so a refresh on
 * `/lessons` would 404. A hash route never reaches the server.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      {/* The v7 flags are opted into now so the behaviour this app was
          built and tested against is the behaviour it keeps on upgrade. */}
      <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </HashRouter>
    </StoreProvider>
  </StrictMode>,
)

registerServiceWorker()
