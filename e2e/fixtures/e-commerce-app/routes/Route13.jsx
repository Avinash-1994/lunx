import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg13.jsx'));

export default function Route13() {
  return <div>
    <h1>Route 13</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
