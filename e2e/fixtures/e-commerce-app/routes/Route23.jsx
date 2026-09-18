import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg23.jsx'));

export default function Route23() {
  return <div>
    <h1>Route 23</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
