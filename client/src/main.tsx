import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './styles.css';
import { exportPng } from './canvas/CanvasEditor.tsx';
import { useEditor } from './store.ts';

if (import.meta.env.DEV) Object.assign(window, { __crux: { exportPng, useEditor } });

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
