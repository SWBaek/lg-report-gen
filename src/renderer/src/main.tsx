import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/pretendard/400.css';
import '@fontsource/pretendard/600.css';
import '@fontsource/pretendard/700.css';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './app/App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
