import React, { lazy, Suspense } from 'react';
const LazyImg = lazy(() => import('../src/LazyImg39.jsx'));

export default function Route39() {
  return <div>
    <h1>Route 39</h1>
    <Suspense fallback={<div>Loading image...</div>}>
       <LazyImg />
    </Suspense>
  </div>;
}
