import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg7.jsx'));

export default function Route7() {
  return <div>
    <h1>Route 7</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
