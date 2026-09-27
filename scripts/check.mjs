import {readFileSync, readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

const base = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(base, 'extension/manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(resolve(base, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error('Extension and package versions must match before release.');
for (const folder of ['extension', 'demo', 'scripts', 'tests', 'backend', 'backend/api']) {
  for (const name of readdirSync(resolve(base, folder))) {
    if (/\.(m?js)$/.test(name)) execFileSync(process.execPath, ['--check', resolve(base, folder, name)], {stdio: 'pipe'});
  }
}
if (manifest.manifest_version !== 3 || manifest.host_permissions) throw new Error('Expected an MV3 extension with optional, per-site access.');
for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page, manifest.side_panel.default_path, 'sidepanel.js', 'sidepanel.css', 'review-loader.js', 'content.js', 'inspector.js', 'offscreen.html', 'offscreen.js', 'report.html', 'report.js', 'report.css', 'report-format.mjs', 'review-store.mjs', 'ai-config.mjs', 'ai-client.mjs', 'mcp-client.mjs', 'mcp-config.mjs', 'mcp-settings.js', 'ai-settings.js', 'ai-settings.css']) readFileSync(resolve(base, 'extension', file));
for (const file of ['diff.html','diff.js','diff.css','jira-settings.html','jira-settings.js','jira-settings.css','jira-connection.mjs','jira-export.mjs','jira-export.css','jira-format.mjs',...new Set([...Object.values(manifest.icons || {}), ...Object.values(manifest.action.default_icon || {})])]) readFileSync(resolve(base, 'extension', file));
if (!manifest.permissions.includes('identity')) throw new Error('Jira authorization requires Chrome identity permission.');
if (!manifest.permissions.includes('debugger')) throw new Error('Responsive viewport presets require Chrome debugger permission.');
readFileSync(resolve(base,'extension/viewport-controller.mjs'));
for (const file of ['viewport-profile.mjs','viewport-panel.js','viewport-panel.css','select-controls.js','ui-chrome.css','report-sidebar.css','ui-theme.css','ai-handoff.mjs','review-transfer.mjs','settings.html','settings.css']) readFileSync(resolve(base, 'extension', file));
console.log('Extension manifest, referenced files, and JavaScript syntax are valid.');
