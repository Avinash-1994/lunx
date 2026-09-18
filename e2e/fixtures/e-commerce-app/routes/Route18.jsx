import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg18.jsx'));

export default function Route18() {
  return <div>
    <h1>Route 18</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
