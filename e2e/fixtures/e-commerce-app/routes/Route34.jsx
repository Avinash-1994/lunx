import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg34.jsx'));

export default function Route34() {
  return <div>
    <h1>Route 34</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
