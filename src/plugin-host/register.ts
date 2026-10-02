/**
 * `node --import lunx/dist/plugin-host/register.js`: the `vite` redirect for
 * child processes a framework CLI starts (vinxi builds in a subprocess).
 */

import { installRedirects } from './loader.js';

installRedirects();
