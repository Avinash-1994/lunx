import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg20.jsx'));

export default function Route20() {
  return <div>
    <h1>Route 20</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
