// 全脊椎2段階モデル（spine-measure-assistで学習）で脊椎骨盤の計測点を自動配置する。
// Stage1(YOLOv8)で全体画像から27領域の枠を検出し、Stage2(HRNet)で枠ごとに最大4点を検出する。
// 学習側の推論（slicer/WholeSpineAssist/lib/whole_spine_inference.py）をそのまま移植したもので、
// 前処理（パーセンタイル正規化・align_corners=Falseのバイリニア縮小・中央ゼロパディング）も揃えている。
// 96点のうち脊椎骨盤の計測に使う 骨盤(大腿骨頭)・S1・L1・C7 の4領域だけStage2を回す。
// モデル・ランタイムの置き場所と読み込みは ort.js を参照。
import { loadOrt, createSession } from './ort.js';

const STAGE1 = { model: 'detector_img1024.onnx', size: 1024 };
const STAGE2 = { model: 'whole_spine_stage2_final.onnx', data: 'whole_spine_stage2_final.onnx.data' };
const CONF_THRESHOLD = 0.3;  // Stage1の検出閾値（学習側と同じ）
const LOW_CONF = 0.05;       // Stage2のヒートマップ峰がこれ未満なら信頼度低として警告

// 学習側 landmark_scheme.py の BBOX_CLASSES と同順（YOLOのクラスID）
const BBOX_CLASSES = [
  'skull', 'C2',
  ...[3, 4, 5, 6, 7].map(i => `C${i}`),
  ...Array.from({ length: 12 }, (_, i) => `T${i + 1}`),
  ...[1, 2, 3, 4, 5].map(i => `L${i}`),
  'L6', 'S1', 'pelvis',
];
// Stage2の出力4チャンネルの意味（landmark_scheme.py の REGION_CHANNELS のうち使う領域のみ）。
// 椎体の _1=上前縁, _2=上後縁。下縁の _3/_4 は注釈で前後が揃っていないため位置関係で判定する。
const REGION_CHANNELS = {
  pelvis: ['FH', null, null, null],
  S1: ['S1_1', 'S1_2', null, null],
  L1: ['L1_1', 'L1_2', null, null],
  C7: ['C7_1', 'C7_2', 'C7_3', 'C7_4'],
};

let readyPromise = null;
function getReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const ort = await loadOrt();
      const stage1 = await createSession(ort, STAGE1.model);
      const stage2 = await createSession(ort, STAGE2.model, STAGE2.data);
      return { ort, stage1, stage2 };
    })();
    readyPromise.catch(() => { readyPromise = null; }); // 失敗時は次回押下で再試行できるようにする
  }
  return readyPromise;
}

// 表示用canvas（骨が白）を1chの輝度配列にする。学習データはMONOCHROME1のDICOM画素値を
// 反転せずに使っている（骨が黒）ため、ここで反転して学習時と同じ極性に揃える。
function toModelGray(bitmap, w, h) {
  const d = bitmap.getContext('2d').getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; p < g.length; i += 4, p++) {
    g[p] = 255 - (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  }
  return g;
}

// numpy.percentile（線形補間）相当
function percentile(sorted, q) {
  const pos = (sorted.length - 1) * q, i = Math.floor(pos), f = pos - i;
  return i + 1 < sorted.length ? sorted[i] + (sorted[i + 1] - sorted[i]) * f : sorted[i];
}

// 1-99パーセンタイルでクリップして[0,1]に正規化（学習側 _percentile_clip_norm と同じ）
function percentileClipNorm(img) {
  const s = img.slice().sort();
  const lo = percentile(s, 0.01), hi = percentile(s, 0.99);
  const span = hi - lo + 1e-6;
  const out = new Float32Array(img.length);
  for (let i = 0; i < img.length; i++) out[i] = (Math.min(Math.max(img[i], lo), hi) - lo) / span;
  return out;
}

// torch.nn.functional.interpolate(mode='bilinear', align_corners=False) 相当の縮小（アンチエイリアス無し）
function resizeBilinear(src, w, h, nw, nh) {
  const axis = (n, nn) => {
    const i0 = new Int32Array(nn), i1 = new Int32Array(nn), f = new Float32Array(nn);
    for (let k = 0; k < nn; k++) {
      const x = Math.min(Math.max((k + 0.5) * (n / nn) - 0.5, 0), n - 1);
      i0[k] = Math.floor(x); i1[k] = Math.min(i0[k] + 1, n - 1); f[k] = x - i0[k];
    }
    return { i0, i1, f };
  };
  const ax = axis(w, nw), ay = axis(h, nh);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const r0 = ay.i0[y] * w, r1 = ay.i1[y] * w, fy = ay.f[y];
    for (let x = 0; x < nw; x++) {
      const a = ax.i0[x], b = ax.i1[x], fx = ax.f[x];
      const top = src[r0 + a] + (src[r0 + b] - src[r0 + a]) * fx;
      const bot = src[r1 + a] + (src[r1 + b] - src[r1 + a]) * fx;
      out[y * nw + x] = top + (bot - top) * fy;
    }
  }
  return out;
}

// 縦横比を維持して size 四方に縮小し中央にゼロパディング（学習側 _pad_resize と同じ）
function padResize(img, w, h, size) {
  const scale = Math.min(size / h, size / w);
  const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
  const resized = resizeBilinear(img, w, h, nw, nh);
  const padX = Math.floor((size - nw) / 2), padY = Math.floor((size - nh) / 2);
  const out = new Float32Array(size * size);
  for (let y = 0; y < nh; y++) out.set(resized.subarray(y * nw, (y + 1) * nw), (y + padY) * size + padX);
  return { data: out, scale, padX, padY };
}

// Stage1: 27領域の枠を検出し、クラスごとに最も信頼度の高い1枠を残す（学習側と同じくNMS省略）
async function detectBoxes(ort, session, gray, w, h) {
  const S = STAGE1.size;
  const { data, scale, padX, padY } = padResize(percentileClipNorm(gray), w, h, S);
  const input = new Float32Array(3 * S * S);
  input.set(data, 0); input.set(data, S * S); input.set(data, 2 * S * S);
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, S, S]) });
  const pred = out[session.outputNames[0]];
  const [, ch, na] = pred.dims;   // (1, 4+クラス数, アンカー数)
  const p = pred.data;
  const best = {};
  for (let i = 0; i < na; i++) {
    let cls = -1, conf = -Infinity;
    for (let c = 4; c < ch; c++) { const v = p[c * na + i]; if (v > conf) { conf = v; cls = c - 4; } }
    if (conf < CONF_THRESHOLD || cls >= BBOX_CLASSES.length) continue;
    const region = BBOX_CLASSES[cls];
    if (best[region] && conf <= best[region].conf) continue;
    const cx = p[i], cy = p[na + i], bw = p[2 * na + i], bh = p[3 * na + i];
    best[region] = {
      conf,
      x1: Math.max(0, Math.trunc((cx - bw / 2 - padX) / scale)),
      y1: Math.max(0, Math.trunc((cy - bh / 2 - padY) / scale)),
      x2: Math.min(w - 1, Math.trunc((cx + bw / 2 - padX) / scale)),
      y2: Math.min(h - 1, Math.trunc((cy + bh / 2 - padY) / scale)),
    };
  }
  return best;
}

// Stage2: 枠で切り出した領域から各チャンネルのヒートマップ峰を求め、元画像座標で返す
async function detectRegionPoints(ort, session, gray, w, region, box) {
  const cw = box.x2 - box.x1 + 1, chh = box.y2 - box.y1 + 1;
  if (cw <= 0 || chh <= 0) return {};
  const crop = new Float32Array(cw * chh);
  for (let y = 0; y < chh; y++) crop.set(gray.subarray((box.y1 + y) * w + box.x1, (box.y1 + y) * w + box.x1 + cw), y * cw);
  const S = 256;
  const { data, scale, padX, padY } = padResize(percentileClipNorm(crop), cw, chh, S);
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 1, S, S]) });
  const hm = out[session.outputNames[0]].data, stride = S * S;
  const result = {};
  REGION_CHANNELS[region].forEach((key, c) => {
    if (!key) return;
    let bestV = -Infinity, bi = 0;
    for (let i = 0; i < stride; i++) { const v = hm[c * stride + i]; if (v > bestV) { bestV = v; bi = i; } }
    const x = bi % S, y = Math.floor(bi / S);
    result[key] = { x: (x - padX) / scale + box.x1, y: (y - padY) / scale + box.y1, conf: bestV };
  });
  return result;
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const LABELS = { pelvis: '骨盤（大腿骨頭）', S1: 'S1', L1: 'L1', C7: 'C7' };

// bitmap(state.bitmap, w x h) から脊椎骨盤プリセットの点を推定する。
// 返り値: { points: id -> {x,y}（画像座標系）, warnings: string[] }
export async function detectSpinopelvicLandmarks(bitmap, w, h) {
  const { ort, stage1, stage2 } = await getReady();
  const gray = toModelGray(bitmap, w, h);
  const boxes = await detectBoxes(ort, stage1, gray, w, h);

  const lm = {}, warnings = [];
  for (const region of Object.keys(REGION_CHANNELS)) {
    if (!boxes[region]) { warnings.push(`${LABELS[region]}を検出できず`); continue; }
    const pts = await detectRegionPoints(ort, stage2, gray, w, region, boxes[region]);
    for (const [key, p] of Object.entries(pts)) {
      lm[key] = p;
      if (p.conf < LOW_CONF) warnings.push(`${key}の信頼度が低い`);
    }
  }

  const points = {};
  // モデルの大腿骨頭は両側の中点1点（FH）なので、左右とも同じ位置に置く（股関節軸＝FH）
  if (lm.FH) { points.femL = { x: lm.FH.x, y: lm.FH.y }; points.femR = { x: lm.FH.x, y: lm.FH.y }; }
  if (lm.S1_1 && lm.S1_2) { points.s1a = lm.S1_1; points.s1p = lm.S1_2; }
  if (lm.L1_1 && lm.L1_2) { points.l1a = lm.L1_1; points.l1p = lm.L1_2; }
  if (lm.C7_1 && lm.C7_2 && lm.C7_3 && lm.C7_4) {
    // 前壁中点・後壁中点を C7前縁/後縁とする（2点の中点＝4角点の重心＝学習側SVAのC7椎体中心）
    const [infAnt, infPost] = dist(lm.C7_1, lm.C7_3) <= dist(lm.C7_1, lm.C7_4) ? [lm.C7_3, lm.C7_4] : [lm.C7_4, lm.C7_3];
    points.c7a = mid(lm.C7_1, infAnt);
    points.c7p = mid(lm.C7_2, infPost);
  }
  for (const p of Object.values(points)) delete p.conf;
  return { points, warnings };
}
