import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg9.jsx'));

export default function Route9() {
  return <div>
    <h1>Route 9</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
