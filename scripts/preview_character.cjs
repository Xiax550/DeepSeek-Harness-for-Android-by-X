const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../payload/opt/dsh/android');
const skinPreview = process.env.DHA_SKIN_PREVIEW && path.resolve(process.env.DHA_SKIN_PREVIEW);
const port = Number(process.env.DHA_CHARACTER_PORT) || 18764;
const preview = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>DHA Character Preview</title>
<style>body{margin:24px;background:#e5e9ed;color:#202124;font:14px system-ui}header{display:flex;gap:8px;flex-wrap:wrap}button{padding:8px}main{display:flex;gap:32px;flex-wrap:wrap;margin-top:20px}iframe{border:0;display:block;background:transparent}section{min-width:100px}label{display:block;margin:8px 0}</style>
<header><button onclick="side('left')">Left</button><button onclick="side('right')">Right</button><button onclick="mode('open')">Input</button><button onclick="mode('think')">Working</button><button onclick="mode('result')">Result</button><button onclick="mode('idle')">Idle</button><button onclick="document.querySelectorAll('iframe').forEach(f=>f.contentWindow.BallUI.resting(true))">Rest</button></header>
<main><section><label>58 dp</label><iframe title="Compact" width="58" height="58" src="/ball-web/composer.html?preview=58"></iframe></section><section><label>96 dp</label><iframe title="Large" width="96" height="96" src="/ball-web/composer.html?preview=96"></iframe></section><section><label>300 px inspection</label><iframe title="Inspection" width="300" height="300" src="/ball-web/composer.html?preview=300"></iframe></section><section><label>Interactive</label><iframe title="Interactive" id="interactive" width="360" height="210" src="/ball-web/composer.html?preview=58"></iframe></section></main>
<script>function side(s){document.querySelectorAll('iframe').forEach(f=>f.contentWindow.ComposerUI.side(s))}function mode(m){const f=document.querySelector('#interactive'),w=f.contentWindow;if(m==='open'){f.width=360;f.height=150;w.ComposerUI.open()}if(m==='think')w.BallUI.bubble('thinking','正在处理');if(m==='result')w.BallUI.bubble('result','任务已完成。'+('这是用于检查滚动和关闭按钮的结果。'.repeat(35)));if(m==='idle'){f.width=58;f.height=58;w.BallUI.collapseDone()}}</script></html>`;
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(preview); return; }
  let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  if (skinPreview && /^\/ball-web\/coo\/tex\/[a-z_]+\.png$/.test(url.pathname)) {
    file = path.join(skinPreview, 'tex', path.basename(file));
  }
  try {
    let content = fs.readFileSync(file);
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream');
    if (url.pathname.endsWith('/composer.html')) {
      const size = Number(url.searchParams.get('preview')) || 58;
      const bridge = `<script>window.DshBall={size:()=>${size},pad:()=>8,x:()=>0,y:()=>0,side:()=> 'left',image:()=>'',log:console.log,bubbleSize:(w,h)=>{if(frameElement){frameElement.width=w;frameElement.height=h}}};window.DshComposer={send:console.log,close:()=>BallUI.collapseDone(),watch:()=>{},log:console.log};</script>`;
      content = content.toString().replace('<script src="./reference/figure.js">', bridge + '<script src="./reference/figure.js">');
    }
    res.end(content);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log('Character preview: http://127.0.0.1:' + port));
