import React from 'react';

export interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
  badge?: string;
  rating: number;
}

const PRODUCTS: Product[] = [
  { id: '1', name: 'Lunx Turbo Compiler Pro', price: 199, category: 'Dev Tools', badge: 'Best Seller', rating: 4.9 },
  { id: '2', name: 'SWC + LightningCSS Accelerator', price: 99, category: 'Build Tools', badge: 'New', rating: 4.8 },
  { id: '3', name: 'Module Federation Runtime Suite', price: 149, category: 'Architecture', badge: 'Popular', rating: 5.0 },
  { id: '4', name: 'Zero-Trust Security Scanner', price: 299, category: 'Security', badge: 'Enterprise', rating: 4.95 }
];

export default function ProductCatalog({ onAddToCart }: { onAddToCart?: (product: Product) => void }) {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', color: '#f4f4f5' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 700, color: '#60a5fa' }}>⚡ Remote Product Catalog</h2>
          <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#a1a1aa' }}>Exposed via Lunx Module Federation (`catalogRemote/ProductCatalog`)</p>
        </div>
        <span style={{ padding: '4px 12px', background: '#3b82f620', border: '1px solid #3b82f640', borderRadius: '99px', fontSize: '12px', color: '#93c5fd', fontWeight: 600 }}>
          Remote Port :5091
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
        {PRODUCTS.map((item) => (
          <div
            key={item.id}
            style={{
              background: '#18181b',
              border: '1px solid #27272a',
              borderRadius: '12px',
              padding: '20px',
              transition: 'all 0.2s ease',
              boxShadow: '0 4px 12px rgba(0,0,0,0.2)'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: '#38bdf8', letterSpacing: '0.5px' }}>{item.category}</span>
              {item.badge && (
                <span style={{ background: '#05966920', border: '1px solid #05966940', color: '#34d399', fontSize: '10px', padding: '2px 8px', borderRadius: '4px', fontWeight: 700 }}>
                  {item.badge}
                </span>
              )}
            </div>
            <h3 style={{ margin: '0 0 8px', fontSize: '16px', fontWeight: 600, color: '#ffffff' }}>{item.name}</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '16px', fontSize: '13px', color: '#fbbf24' }}>
              {'★'.repeat(Math.floor(item.rating))} <span style={{ color: '#a1a1aa', fontSize: '12px', marginLeft: '4px' }}>({item.rating})</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '12px', borderTop: '1px solid #27272a' }}>
              <span style={{ fontSize: '20px', fontWeight: 800, color: '#f4f4f5' }}>${item.price}</span>
              <button
                onClick={() => onAddToCart && onAddToCart(item)}
                style={{
                  background: 'linear-gradient(135deg, #2563eb, #3b82f6)',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '8px 16px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: 'pointer',
                  boxShadow: '0 2px 8px rgba(37,99,235,0.4)'
                }}
              >
                + Add to Cart
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
