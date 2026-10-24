import { fileURLToPath, URL } from 'node:url';
import { createReadStream, existsSync } from 'node:fs';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const resolveSrc = p => fileURLToPath(new URL(p, import.meta.url));

// AI自動計測用のONNXモデル/onnxruntime-web WASM(計13MB超)は、
// vite-plugin-singlefileのインライン化対象から外すため src/ の外
// (リポジトリ直下 apps/<app>/model/) に素のファイルとして置く
// （本番配信そのままの場所なので、src/public 等への複製は作らない）。
// devサーバーでも同じ相対パス /apps/<app>/model/* で読めるよう、ここでのみ配信する。
const MIME = { '.wasm': 'application/wasm', '.mjs': 'text/javascript', '.onnx': 'application/octet-stream' };
const serveAiModel = () => ({
  name: 'serve-ai-model',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const m = req.url && req.url.match(/^\/apps\/(cervical|spinopelvic)\/model\/([\w.-]+)$/);
      if (!m) return next();
      const filePath = resolveSrc(`apps/${m[1]}/model/${m[2]}`);
      if (!existsSync(filePath)) return next();
      res.setHeader('Content-Type', MIME[filePath.slice(filePath.lastIndexOf('.'))] || 'application/octet-stream');
      createReadStream(filePath).pipe(res);
    });
  },
});

// ソースは src/ で分割管理し、配布用に各ページを単一HTMLへインライン化してビルドする
// （マルチページ: src/index.html=ホーム, src/apps/<app>/index.html=各計測アプリ）。
// vite-plugin-singlefile は単一エントリしか扱えない(inlineDynamicImportsの制約)ため、
// PAGE 環境変数でページごとに個別ビルドする（build script 側でページ数分呼び出す）。
// 出力(dist/*)は npm script でリポジトリ直下にコピーし、
// GitHub Pages 配信物・ローカル配布物・ローカル版ダウンロードのすべてを兼ねる。
const PAGES = {
  home:        'src/index.html',
  spinopelvic: 'src/apps/spinopelvic/index.html',
  cervical:    'src/apps/cervical/index.html',
};
const entry = PAGES[process.env.PAGE] || PAGES.home;

export default defineConfig({
  root: 'src',
  base: './',          // file:// で直接開けるよう相対パスにする
  plugins: [serveAiModel(), viteSingleFile()],
  build: {
    // 出力先はエントリのrootからの相対パスを保つので、両ページとも同じoutDirでよい
    // (home: dist/index.html, spinopelvic: dist/spinopelvic/index.html)
    outDir: '../dist',
    emptyOutDir: false, // dist/ 全体のクリアは build script 側の rm -rf dist で行う
    assetsInlineLimit: 100000000,
    rollupOptions: {
      input: resolveSrc(entry),
    },
  },
});
