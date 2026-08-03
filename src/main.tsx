import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import AuthApp from './AuthApp.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthApp />
  </StrictMode>,
);
