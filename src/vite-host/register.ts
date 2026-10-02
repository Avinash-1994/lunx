/**
 * `node --import lunx/dist/vite-host/register.js`: the `vite` redirect for
 * child processes a framework CLI starts (vinxi builds in a subprocess).
 */

import { installViteRedirect } from './loader.js';

installViteRedirect();
