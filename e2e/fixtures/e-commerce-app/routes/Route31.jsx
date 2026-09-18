import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg31.jsx'));

export default function Route31() {
  return <div>
    <h1>Route 31</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
