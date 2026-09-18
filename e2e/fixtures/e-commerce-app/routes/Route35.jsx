import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg35.jsx'));

export default function Route35() {
  return <div>
    <h1>Route 35</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
