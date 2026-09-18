import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg24.jsx'));

export default function Route24() {
  return <div>
    <h1>Route 24</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
