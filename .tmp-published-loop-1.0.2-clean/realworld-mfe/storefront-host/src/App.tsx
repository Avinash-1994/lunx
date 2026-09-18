import React, { useState, Suspense } from 'react';

// Dynamically import remote component exposed by catalogRemote
// @ts-ignore
const ProductCatalog = React.lazy(() => import('catalogRemote/ProductCatalog'));

export default function App() {
  const [cart, setCart] = useState<Array<{ id: string; name: string; price: number }>>([]);
  const [activeTab, setActiveTab] = useState<'catalog' | 'architecture'>('catalog');

  const handleAddToCart = (product: { id: string; name: string; price: number }) => {
    setCart((prev) => [...prev, product]);
  };

  const totalPrice = cart.reduce((acc, curr) => acc + curr.price, 0);

  return (
    <div style={{ minHeight: '100vh', background: '#09090b', color: '#f4f4f5', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Top Header */}
      <header style={{ borderBottom: '1px solid #27272a', background: 'rgba(18, 18, 20, 0.8)', backdropFilter: 'blur(12px)', sticky: 'top', position: 'sticky', top: 0, zIndex: 50 }}>
        <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '16px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '18px', boxShadow: '0 0 20px rgba(59,130,246,0.5)' }}>
              ⚡
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 800, letterSpacing: '-0.5px' }}>
                Lunx <span style={{ color: '#60a5fa' }}>DevStore MFE</span>
              </h1>
              <span style={{ fontSize: '11px', color: '#a1a1aa' }}>Micro-Frontend Architecture Demo</span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            <nav style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setActiveTab('catalog')}
                style={{
                  background: activeTab === 'catalog' ? '#27272a' : 'transparent',
                  color: activeTab === 'catalog' ? '#ffffff' : '#a1a1aa',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '6px 14px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: 'pointer'
                }}
              >
                🛍️ Store Catalog
              </button>
              <button
                onClick={() => setActiveTab('architecture')}
                style={{
                  background: activeTab === 'architecture' ? '#27272a' : 'transparent',
                  color: activeTab === 'architecture' ? '#ffffff' : '#a1a1aa',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '6px 14px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: 'pointer'
                }}
              >
                🧩 MFE Architecture
              </button>
            </nav>

            {/* Shopping Cart Pill */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#18181b', border: '1px solid #27272a', padding: '6px 14px', borderRadius: '99px' }}>
              <span style={{ fontSize: '14px' }}>🛒</span>
              <span style={{ fontSize: '13px', fontWeight: 700, color: '#38bdf8' }}>{cart.length} items</span>
              <span style={{ fontSize: '13px', color: '#71717a' }}>|</span>
              <span style={{ fontSize: '13px', fontWeight: 800, color: '#34d399' }}>${totalPrice}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main style={{ maxWidth: '1200px', margin: '0 auto', padding: '32px 24px' }}>
        {activeTab === 'catalog' ? (
          <div>
            <div style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: '16px', padding: '24px', marginBottom: '32px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h3 style={{ margin: '0 0 6px', fontSize: '16px', fontWeight: 700, color: '#f4f4f5' }}>🏠 Storefront Host Shell Application</h3>
                  <p style={{ margin: 0, fontSize: '13px', color: '#a1a1aa' }}>Running on port <code style={{ color: '#38bdf8', background: '#27272a', padding: '2px 6px', borderRadius: '4px' }}>:5090</code>. Dynamically loading the Product Catalog remote component over HTTP via Lunx runtime.</p>
                </div>
                <span style={{ background: '#10b98120', border: '1px solid #10b98140', color: '#34d399', padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700 }}>
                  ● Lunx MFE Online
                </span>
              </div>
            </div>

            {/* Remote Micro-Frontend Component */}
            <Suspense fallback={
              <div style={{ padding: '40px', textAlign: 'center', background: '#18181b', borderRadius: '16px', border: '1px solid #27272a', color: '#a1a1aa' }}>
                ⏳ Dynamic MFE Loading (catalogRemote/ProductCatalog)...
              </div>
            }>
              <ProductCatalog onAddToCart={handleAddToCart} />
            </Suspense>
          </div>
        ) : (
          <div style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: '16px', padding: '32px' }}>
            <h2 style={{ marginTop: 0, color: '#60a5fa' }}>🏗️ Lunx Module Federation Real-World Topology</h2>
            <p style={{ color: '#a1a1aa', fontSize: '14px', lineHeight: 1.6 }}>
              This real-world application demonstrates seamless cross-container component sharing using **Lunx Module Federation** published under <code>lunx-dev@1.0.0</code>.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginTop: '24px' }}>
              <div style={{ background: '#09090b', border: '1px solid #27272a', borderRadius: '12px', padding: '20px' }}>
                <h4 style={{ margin: '0 0 8px', color: '#34d399' }}>Host Application (:5090)</h4>
                <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', color: '#d4d4d8', lineHeight: 1.8 }}>
                  <li>Manages root routing and global cart state</li>
                  <li>Imports <code>catalogRemote/ProductCatalog</code> dynamically at runtime</li>
                  <li>Shares React & ReactDOM singletons with zero duplicated code</li>
                </ul>
              </div>

              <div style={{ background: '#09090b', border: '1px solid #27272a', borderRadius: '12px', padding: '20px' }}>
                <h4 style={{ margin: '0 0 8px', color: '#60a5fa' }}>Catalog Remote (:5091)</h4>
                <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', color: '#d4d4d8', lineHeight: 1.8 }}>
                  <li>Exposes <code>./ProductCatalog</code> component</li>
                  <li>Emits <code>remoteEntry.js</code> manifest</li>
                  <li>Can be developed, tested, and deployed independently</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
