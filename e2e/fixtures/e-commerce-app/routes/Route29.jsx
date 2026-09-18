import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg29.jsx'));

export default function Route29() {
  return <div>
    <h1>Route 29</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
