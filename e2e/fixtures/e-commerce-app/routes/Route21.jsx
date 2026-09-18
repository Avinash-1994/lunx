import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg21.jsx'));

export default function Route21() {
  return <div>
    <h1>Route 21</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
