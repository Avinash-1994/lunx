import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg15.jsx'));

export default function Route15() {
  return <div>
    <h1>Route 15</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
