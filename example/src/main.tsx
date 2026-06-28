import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './cursors.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
