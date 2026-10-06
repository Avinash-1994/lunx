export const AUTO_IMPORTS = [
  'ref',
  'computed',
  'watch',
  'watchEffect',
  'onMounted',
  'onUnmounted',
  'provide',
  'inject',
  'useRoute',
  'useRouter',
  'useFetch',
  'useAsyncData',
  'useState',
  'definePageMeta',
];

export function generateAutoImportsBridge() {
  const imports = AUTO_IMPORTS.join(', ');
  return `
    // Auto-generated bridge for Nuxt auto-imports
    import { ${imports} } from '#imports';
    if (typeof window !== 'undefined') {
      window.__NUXT_AUTO_IMPORTS__ = { ${imports} };
    }
  `;
}
