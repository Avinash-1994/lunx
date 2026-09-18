import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg32.jsx'));

export default function Route32() {
  return <div>
    <h1>Route 32</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
