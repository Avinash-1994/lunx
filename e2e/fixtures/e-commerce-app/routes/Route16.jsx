import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg16.jsx'));

export default function Route16() {
  return <div>
    <h1>Route 16</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
