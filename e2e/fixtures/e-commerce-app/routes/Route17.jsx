import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg17.jsx'));

export default function Route17() {
  return <div>
    <h1>Route 17</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
