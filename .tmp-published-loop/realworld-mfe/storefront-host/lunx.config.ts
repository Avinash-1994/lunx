export default {
  framework: 'react',
  preset: 'spa',
  entry: ['src/main.tsx'],
  server: { port: 5400 },
  federation: {
    name: 'storefrontHost',
    remotes: {
      catalogRemote: 'http://localhost:5401/remoteEntry.js'
    },
    shared: {
      react: { singleton: true, requiredVersion: '^18.3.1' },
      'react-dom': { singleton: true }
    }
  }
};
