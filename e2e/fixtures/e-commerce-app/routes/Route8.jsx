import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg8.jsx'));

export default function Route8() {
  return <div>
    <h1>Route 8</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
