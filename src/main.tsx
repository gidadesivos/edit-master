import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useEditor } from './engine/store';
import './styles.css';

// Block the browser's default "open dropped file" behaviour so a missed drop never navigates away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// Exposed for automated end-to-end tests and debugging from the devtools console.
(window as unknown as { __EDIT_MASTER__: unknown }).__EDIT_MASTER__ = { useEditor };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
