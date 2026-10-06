// SolidStart client entry point
// Lunx Phase 2.4 — SolidStart Streaming SSR Fixture

import { hydrate } from 'solid-js/web';

// window._$HY is injected by the SSR stream's hydration tail chunk
declare global {
  interface Window {
    _$HY: { events: any[]; completed: WeakSet<any>; r: Record<string, any> };
  }
}

// Hydrate the server-rendered root
hydrate(
  () => import('../app/routes/page.tsx').then(m => m.default),
  document.getElementById('root')!
);
