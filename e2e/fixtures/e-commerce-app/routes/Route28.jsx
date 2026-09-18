import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg28.jsx'));

export default function Route28() {
  return <div>
    <h1>Route 28</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
