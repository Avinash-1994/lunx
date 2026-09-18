export default {
  framework: 'react',
  preset: 'spa',
  entry: ['src/main.tsx'],
  server: { port: 5290 },
  federation: {
    name: 'storefrontHost',
    remotes: {
      catalogRemote: 'http://localhost:5291/remoteEntry.js'
    },
    shared: {
      react: { singleton: true, requiredVersion: '^18.3.1' },
      'react-dom': { singleton: true }
    }
  }
};
