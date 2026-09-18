import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg19.jsx'));

export default function Route19() {
  return <div>
    <h1>Route 19</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
