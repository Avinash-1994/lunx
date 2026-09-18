import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg30.jsx'));

export default function Route30() {
  return <div>
    <h1>Route 30</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
