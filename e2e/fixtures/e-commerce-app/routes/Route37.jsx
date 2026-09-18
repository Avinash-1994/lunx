import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg37.jsx'));

export default function Route37() {
  return <div>
    <h1>Route 37</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
