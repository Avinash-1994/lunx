import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg11.jsx'));

export default function Route11() {
  return <div>
    <h1>Route 11</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
