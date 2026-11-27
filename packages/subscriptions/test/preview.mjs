// Local-only fixture for visual review. Never loads credentials or contacts OpenAI.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const dir = fileURLToPath(new URL('..', import.meta.url))
const result = await build({ absWorkingDir: dir, stdin: { resolveDir: dir, loader: 'tsx', contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {SubscriptionsPanel} from './src/client/Panel.tsx';
let accounts = location.search.includes('empty') ? [] : [{key:'oaiapp_sample',account:'demo@example.test',isDefault:true,connected:true,planEnabled:true}];
let settings = {};
const models = [{id:'sample-model-a',name:'Model A',contextWindow:1048576,efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]}, {id:'sample-model-b',name:'Model B',contextWindow:200000,efforts:[]}];
const api = {provider:'chatgpt',status:async()=>({accounts,busy:false}),catalog:async()=>({provider:'chatgpt',settings,models:models.map(m=>({...m,defaultContextWindow:m.contextWindow,contextWindow:settings.contextWindows?.[m.id]??m.contextWindow})),accounts:[{key:'oaiapp_sample',models}]}),save:async s=>{settings=s},effort:async()=>{},logout:async()=>{accounts=[]},login:async()=>{throw new Error('Visual fixture: login disabled')}};
createRoot(document.getElementById('root')).render(<SubscriptionsPanel api={api} close={()=>{}}/>);
` }, bundle: true, write: false, platform: 'browser', jsx: 'automatic', format: 'iife' })
const css = await readFile(new URL('../src/client/styles.css', import.meta.url), 'utf8')
const desktopCss = await readFile(new URL('../../../../deepseek-harness-desktop/desktop.css', import.meta.url), 'utf8').catch(() => '')
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 订阅 · UI 测试预览</title><style>
:root{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#242733;--dsw-alias-label-secondary:#676d7c;--dsw-alias-label-tertiary:#878d9b;--dsw-alias-border-l1:#e8e9ee;--dsw-alias-border-l2:#d8dbe4;--dsw-alias-bg-layer-2:#f7f8fa;--dsw-alias-interactive-bg-hover:#f2f4f8;--dsw-alias-interactive-bg-active:#eef3ff;--dsw-alias-state-business-primary:#4c6ef5;--dsw-alias-button-info-fill:#4c6ef5;--dsw-alias-button-info-hover:#3c5be0;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-state-success-primary:#269a75;--dsw-specific-input-major:#fff;--dsw-alias-state-error-primary:#d74242;--dsw-alias-bg-mask-1:#0005;--dsw-font-family:system-ui,"Microsoft YaHei",sans-serif}
html,body,#root{margin:0;height:100%;} ${css}</style><div id="root"></div><script>
const query = new URLSearchParams(location.search);
if (query.has('en')) document.documentElement.lang='en';
if (query.has('dark')) {
 document.documentElement.setAttribute('data-desktop-dark','');
 document.documentElement.style.cssText='--dsw-alias-bg-base:#141414;--dsw-alias-label-primary:#f9fafb;--dsw-alias-label-secondary:#c4c4c4;--dsw-alias-label-tertiary:#989898;--dsw-alias-border-l1:#333;--dsw-alias-border-l2:#444;--dsw-alias-bg-layer-2:#252525;--dsw-alias-interactive-bg-hover:#303030;--dsw-alias-interactive-bg-active:#303030;--dsw-specific-input-major:#252525;--dsw-alias-state-business-primary:#8da7ff';
}
if (query.has('mac')) {
 document.documentElement.dataset.desktopPlatform='darwin';
 document.documentElement.style.setProperty('--desktop-titlebar-height','48px');
 const style=document.createElement('style');style.textContent=${JSON.stringify(desktopCss)};document.head.append(style);
 const frame=document.createElement('div');frame.style.cssText='height:100%;display:flex';
 const sidebar=document.createElement('div');sidebar.style.cssText='width:260px;flex:none;padding:24px;box-sizing:border-box';sidebar.innerHTML='<h2>deepseek <small>HARNESS</small></h2><p>＋ New Session</p><p>Plugins</p><p>Task Board</p>';
 const content=document.createElement('div');content.style.cssText='flex:1;min-width:0;overflow:hidden';content.append(document.getElementById('root'));
 const overlay=document.createElement('div');overlay.dataset.shellOverlay='';frame.append(sidebar,content,overlay);document.body.append(frame);
 const bar=document.createElement('div');bar.id='desktop-titlebar';document.body.append(bar);
}
</script><script src="/app.js"></script></html>`
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html; charset=utf-8')
  res.end(req.url === '/app.js' ? result.outputFiles[0].text : html)
})
server.listen(0, '127.0.0.1', () => console.log(`UI fixture: http://127.0.0.1:${server.address().port}`))
