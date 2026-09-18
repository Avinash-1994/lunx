import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg1.jsx'));

export default function Route1() {
  return <div>
    <h1>Route 1</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
