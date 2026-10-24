// AI自動計測で共通の onnxruntime-web 読み込み。
// モデル本体とonnxruntime-webのWASMランタイムは各アプリの apps/<app>/model/ に
// 素のファイルとして置いており、vite-plugin-singlefileのインライン化対象から
// 意図的に外している（WASMが13MB超あり、単一HTMLダウンロード版に含めると
// 配布物が肥大化するため）。そのためサーバー経由（GitHub Pages / pnpm try-ai）でのみ動作し、
// ダウンロードした単体HTMLではfetchが404してこの機能だけ使えなくなる
// （他の手動計測機能には影響しない）。
const MODEL_DIR = './model/';

// 文字列prefixだと解決基準が呼び出し元によって変わる（import()はモジュール自身のURL基準、
// fetch()はdocument基準）ため、常にdocument基準の絶対URLへ揃えてから使う。
// このモジュール自体はビルド後にindex.htmlへインライン化されるため import.meta.url は
// 環境によって変わるが、document.baseURI＝ページのURLは開発/本番で一貫している。
export const modelUrl = (name) => new URL(MODEL_DIR + name, document.baseURI).href;

// onnxruntime-web本体は初回のみロードし、以降は使い回す
let ortPromise = null;
export function loadOrt() {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import(/* @vite-ignore */ modelUrl('ort.wasm.min.mjs'));
      ort.env.wasm.wasmPaths = {
        'ort-wasm-simd-threaded.wasm': modelUrl('ort-wasm-simd-threaded.wasm'),
        'ort-wasm-simd-threaded.mjs': modelUrl('ort-wasm-simd-threaded.mjs'),
      };
      ort.env.wasm.numThreads = 1; // file://やCOOP/COEP未設定でも動くようにする
      return ort;
    })();
  }
  return ortPromise;
}

// externalData: 重みがonnx本体に埋め込まれず外部データファイルに分離されている場合のファイル名。
// 明示的にfetchしてバイト列を渡す（pathはグラフ内部の参照名と一致させる必要がある）
export async function createSession(ort, name, externalData) {
  const opts = {};
  if (externalData) {
    const res = await fetch(modelUrl(externalData));
    if (!res.ok) throw new Error(`${externalData}: HTTP ${res.status}`);
    opts.externalData = [{ path: externalData, data: new Uint8Array(await res.arrayBuffer()) }];
  }
  return ort.InferenceSession.create(modelUrl(name), opts);
}
