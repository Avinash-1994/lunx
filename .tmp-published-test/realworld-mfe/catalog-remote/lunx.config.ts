export default {
  framework: 'react',
  preset: 'spa',
  entry: ['src/ProductCatalog.tsx'],
  server: { port: 5291 },
  federation: {
    name: 'catalogRemote',
    filename: 'remoteEntry.js',
    singletonHost: 'http://localhost:5290',
    exposes: {
      './ProductCatalog': './src/ProductCatalog.tsx'
    },
    shared: {
      react: { singleton: true, requiredVersion: '^18.3.1' },
      'react-dom': { singleton: true }
    }
  }
};
