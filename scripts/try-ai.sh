#!/bin/sh
# AI自動計測を手元で試す: AIボタン有効で全ページをビルド → モデルを同梱 → ローカルサーバー起動 → ブラウザで開く。
# モデル一式は apps/<app>/model/ に手動で置く（同意取得前データのモデルのため git 管理外）。
#   apps/cervical/model/    cervical_best.onnx(.data)              頚椎8点
#   apps/spinopelvic/model/ detector_img1024.onnx,
#                           whole_spine_stage2_final.onnx(.data)   全脊椎2段階
#   いずれも onnxruntime-web の ort.wasm.min.mjs / ort-wasm-simd-threaded.{wasm,mjs} を同じ場所に置く。
# 使い方: pnpm try-ai [cervical|spinopelvic]（省略時はホーム）。終了は Ctrl+C。
set -e
cd "$(dirname "$0")/.."

OUT=.ai-preview
PORT=${PORT:-8732}
APP=${1:-}

rm -rf "$OUT"
for page in home spinopelvic cervical; do
  PAGE=$page VITE_AI=1 pnpm exec vite build --outDir "../$OUT" --logLevel warn
done

found=0
for app in cervical spinopelvic; do
  if [ -f "apps/$app/model/ort-wasm-simd-threaded.wasm" ]; then
    cp -R "apps/$app/model" "$OUT/apps/$app/model"; found=1
  else
    echo "注意: apps/$app/model/ が無いため $app の自動計測は使えません" >&2
  fi
done
[ "$found" = 1 ] || { echo "モデルが1つも見つかりません" >&2; exit 1; }

# 他のアプリが使用中なら空いているポートまでずらす
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT + 1)); done
URL="http://localhost:$PORT/${APP:+apps/$APP/}"
echo "開いています: $URL （終了は Ctrl+C）"
(sleep 1 && open "$URL") &
cd "$OUT" && exec python3 -m http.server "$PORT" --bind 127.0.0.1
