// Local-only fixture for visual review. Never loads credentials or contacts OpenAI.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const dir = fileURLToPath(new URL('..', import.meta.url))
const result = await build({ absWorkingDir: dir, stdin: { resolveDir: dir, loader: 'tsx', contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {SubscriptionsPanel} from './src/client/Panel.tsx';
let accounts = [{key:'sample',account:'demo@example.test',plan:'plus',isDefault:true}];
if (location.search.includes('empty')) accounts=[];
let settings = {};
const models = [{id:'sample-model-a',name:'ChatGPT · Model A',contextWindow:272000,efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]}, {id:'sample-model-b',name:'ChatGPT · Model B',contextWindow:128000,efforts:[]}];
const api = {status:async()=>({accounts,busy:false}),catalog:async()=>({settings,models,accounts:[{key:'sample',models}]}),save:async s=>{settings=s},effort:async()=>{},logout:async()=>{accounts=[]},usage:async()=>({supported:true,plan:'plus',windows:[{kind:'session',usedPercent:38,resetsAt:Date.now()+3600000},{kind:'weekly',usedPercent:62,resetsAt:Date.now()+86400000}]}),login:async()=>{throw new Error('Visual fixture: login disabled')}};
createRoot(document.getElementById('root')).render(<SubscriptionsPanel api={api} close={()=>{}}/>);
` }, bundle: true, write: false, platform: 'browser', jsx: 'automatic', format: 'iife' })
const css = await readFile(new URL('../src/client/styles.css', import.meta.url), 'utf8')
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 订阅 · UI 测试预览</title><style>
:root{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#242733;--dsw-alias-label-secondary:#676d7c;--dsw-alias-label-tertiary:#878d9b;--dsw-alias-border-l1:#e8e9ee;--dsw-alias-border-l2:#d8dbe4;--dsw-alias-bg-layer-2:#f7f8fa;--dsw-alias-interactive-bg-hover:#f2f4f8;--dsw-alias-interactive-bg-active:#eef3ff;--dsw-alias-state-business-primary:#4c6ef5;--dsw-alias-button-info-fill:#4c6ef5;--dsw-alias-button-info-hover:#3c5be0;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-state-success-primary:#269a75;--dsw-specific-input-major:#fff;--dsw-alias-state-error-primary:#d74242;--dsw-alias-bg-mask-1:#0005;--dsw-font-family:system-ui,"Microsoft YaHei",sans-serif}
html,body,#root{margin:0;height:100%;} ${css}</style><div id="root"></div><script src="/app.js"></script></html>`
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html; charset=utf-8')
  res.end(req.url === '/app.js' ? result.outputFiles[0].text : html)
})
server.listen(0, '127.0.0.1', () => console.log(`UI fixture: http://127.0.0.1:${server.address().port}`))
