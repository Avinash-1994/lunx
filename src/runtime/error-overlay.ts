const styles = `
:host {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 99999;
  --bg-color: #18181b;
  --text-color: #fafafa;
  --red: #ef4444;
  --dim-red: rgba(239, 68, 68, 0.1);
  --yellow: #eab308;
  --dim-yellow: rgba(234, 179, 8, 0.1);
  --border: #27272a;
  --code-bg: #09090b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

:host(.light) {
  --bg-color: #ffffff;
  --text-color: #18181b;
  --border: #e4e4e7;
  --code-bg: #f4f4f5;
}

.overlay {
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(4px);
  display: flex;
  flex-direction: column;
  padding: 2rem;
  box-sizing: border-box;
  overflow: auto;
}

.container {
  background: var(--bg-color);
  color: var(--text-color);
  border-radius: 12px;
  border: 1px solid var(--border);
  max-width: 900px;
  width: 100%;
  margin: 0 auto;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: 90vh;
}

.header {
  background: var(--bg-color);
  border-bottom: 1px solid var(--border);
  padding: 0 1.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 60px;
  flex-shrink: 0;
}

.tabs {
  display: flex;
  height: 100%;
}

.tab {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 1rem;
  height: 100%;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  color: #71717a;
  font-weight: 500;
  transition: all 0.2s;
}

.tab:hover {
  color: var(--text-color);
  background: var(--dim-red);
}

.tab.active {
  color: var(--text-color);
  border-bottom-color: var(--red);
}

.tab.active.runtime {
  border-bottom-color: var(--red);
}

.tab.active.build {
  border-bottom-color: var(--yellow);
}

.badge {
  padding: 0.125rem 0.375rem;
  border-radius: 999px;
  font-size: 0.75rem;
  background: var(--dim-red);
  color: var(--red);
}

.actions {
  display: flex;
  gap: 0.5rem;
}

.btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-color);
  padding: 0.375rem 0.75rem;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.875rem;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.btn:hover {
  background: var(--border);
}

.content {
  padding: 1.5rem;
  overflow-y: auto;
  flex: 1;
}

.error-item {
  margin-bottom: 2rem;
  animation: fade-in 0.2s ease-out;
}

@keyframes fade-in {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: translateY(0); }
}

.message {
  font-size: 1.125rem;
  line-height: 1.6;
  margin-bottom: 1rem;
  white-space: pre-wrap;
  font-weight: 500;
}

.file-link {
  color: #a1a1aa;
  font-size: 0.875rem;
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  padding: 0.5rem;
  border-radius: 4px;
  background: var(--code-bg);
  width: fit-content;
}

.file-link:hover {
  color: var(--text-color);
  background: var(--border);
}

.code-frame {
  background: var(--code-bg);
  padding: 1rem;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 0.875rem;
  line-height: 1.5;
  border: 1px solid var(--border);
  margin-top: 1rem;
}

.stack-trace {
  margin-top: 1rem;
  font-size: 0.875rem;
  color: #71717a;
}

.stack-frame {
  padding: 0.25rem 0;
  cursor: pointer;
}

.stack-frame:hover {
  color: var(--text-color);
  text-decoration: underline;
}
`;

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class ErrorOverlay extends HTMLElement {
  root: ShadowRoot;
  private _errors: any[] = [];
  private _activeTab: 'build' | 'typecheck' | 'runtime' = 'build';

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
    this.setupKeyboard();
  }

  setupKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.dismiss();
      }
    });
  }

  set errors(errors: any[]) {
    this._errors = errors;
    // Auto-switch tab based on error type
    if (errors.some(e => e.type === 'build')) {
      this._activeTab = 'build';
    } else if (errors.some(e => e.type === 'typecheck')) {
      this._activeTab = 'typecheck';
    } else if (errors.some(e => e.type === 'runtime')) {
      this._activeTab = 'runtime';
    }
    this.render();
  }

  dismiss() {
    this.style.display = 'none';
    this._errors = [];
  }

  openInEditor(file: string, line: number = 1, col: number = 1) {
    fetch(`/__open-in-editor?file=${encodeURIComponent(file)}&line=${line}&column=${col}`)
      .catch(e => console.error('Failed to open in editor:', e));
  }

  render() {
    if (this._errors.length === 0) {
      this.style.display = 'none';
      return;
    }

    this.style.display = 'block';

    const buildErrors = this._errors.filter(e => e.type === 'build');
    const typeErrors = this._errors.filter(e => e.type === 'typecheck');
    const runtimeErrors = this._errors.filter(e => e.type === 'runtime');
    const activeErrors = this._activeTab === 'build' ? buildErrors : this._activeTab === 'typecheck' ? typeErrors : runtimeErrors;

    this.root.innerHTML = `
      <style>${styles}</style>
      <div class="overlay">
        <div class="container">
          <div class="header">
            <div class="tabs">
              ${buildErrors.length > 0 ? `
                <div class="tab ${this._activeTab === 'build' ? 'active build' : ''}" onclick="this.getRootNode().host.switchTab('build')">
                  Build Errors
                  <span class="badge">${buildErrors.length}</span>
                </div>
              ` : ''}
              ${typeErrors.length > 0 ? `
                <div class="tab ${this._activeTab === 'typecheck' ? 'active build' : ''}" onclick="this.getRootNode().host.switchTab('typecheck')">
                  Type Errors
                  <span class="badge">${typeErrors.length}</span>
                </div>
              ` : ''}
              ${runtimeErrors.length > 0 ? `
                <div class="tab ${this._activeTab === 'runtime' ? 'active runtime' : ''}" onclick="this.getRootNode().host.switchTab('runtime')">
                  Runtime Errors
                  <span class="badge">${runtimeErrors.length}</span>
                </div>
              ` : ''}
            </div>
            <div class="actions">
              <button class="btn" onclick="this.getRootNode().host.dismiss()">
                Dismiss (Esc)
              </button>
            </div>
          </div>
          <div class="content">
            ${activeErrors.map(error => this.renderError(error)).join('')}
          </div>
        </div>
      </div>
    `;
  }

  switchTab(tab: 'build' | 'typecheck' | 'runtime') {
    this._activeTab = tab;
    this.render();
  }

  renderError(error: any) {
    const file = error.location?.file || error.filename || error.file;
    const line = Number(error.location?.line || error.lineno || error.line) || 1;
    const col = Number(error.location?.column || error.colno || error.column) || 1;
    // Compiler messages hold markup-like text (`Promise<string>`, `<div>`): shown as text.
    const message = escapeHtml(error.text || error.message || 'Unknown error');

    return `
      <div class="error-item">
        <div class="message">${message}</div>
        
        ${file ? `
          <div class="file-link" onclick="this.getRootNode().host.openInEditor(${escapeHtml(JSON.stringify(String(file)))}, ${line}, ${col})">
            <span>📄 ${escapeHtml(String(file))}:${line}:${col}</span>
            <span style="margin-left: auto; font-size: 0.75rem; opacity: 0.7;">Click to open</span>
          </div>
        ` : ''}

        ${error.frame ? `<pre class="code-frame">${escapeHtml(String(error.frame))}</pre>` : ''}
        
        ${error.stack ? `
          <div class="stack-trace">
            ${this.formatStack(error.stack)}
          </div>
        ` : ''}
      </div>
    `;
  }

  formatStack(stack: string) {
    return stack.split('\n').map(line => {
      // Basic parsing to make file paths clickable (simplified)
      const match = line.match(/\((.*):(\d+):(\d+)\)/);
      if (match) {
        const [_, file, l, c] = match;
        return `<div class="stack-frame" onclick="this.getRootNode().host.openInEditor(${escapeHtml(JSON.stringify(file))}, ${Number(l)}, ${Number(c)})">${escapeHtml(line)}</div>`;
      }
      return `<div>${escapeHtml(line)}</div>`;
    }).join('');
  }
}

// Expose methods to DOM
(ErrorOverlay.prototype as any).switchTab = ErrorOverlay.prototype.switchTab;
(ErrorOverlay.prototype as any).dismiss = ErrorOverlay.prototype.dismiss;
(ErrorOverlay.prototype as any).openInEditor = ErrorOverlay.prototype.openInEditor;

if (!customElements.get('lunx-error-overlay')) {
  customElements.define('lunx-error-overlay', ErrorOverlay);
}
