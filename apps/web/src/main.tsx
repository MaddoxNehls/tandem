import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import '@fontsource-variable/schibsted-grotesk/index.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.js';
import { boot } from './boot.js';

const root = createRoot(document.getElementById('root')!);

boot()
  .then(({ ws }) => {
    root.render(<App ws={ws} />);
    // Expose for end-to-end tests and debugging.
    (window as unknown as { tandem: unknown }).tandem = ws;
  })
  .catch((err: unknown) => {
    console.error(err);
    root.render(
      <div className="fatal">
        <p>Tandem couldn't open its local storage, so it can't start.</p>
        <p>Private browsing or blocked site data can cause this. Allow site data for this page and reload.</p>
      </div>,
    );
  });

if (import.meta.env.PROD) registerSW({ immediate: true });
