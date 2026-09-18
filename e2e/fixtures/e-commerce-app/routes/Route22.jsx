import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg22.jsx'));

export default function Route22() {
  return <div>
    <h1>Route 22</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
