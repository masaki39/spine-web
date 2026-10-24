import { PRESETS } from './preset.js';

// どのプリセットを使うかは各アプリの <body data-preset="..."> で指定する
// （main.js/app.js/render.js は全アプリで共通のまま、プリセットだけ差し替わる）。
const presetId = document.body.dataset.preset || 'spinopelvic';

//==================================================================
// 状態
//==================================================================
export const state = {
  preset: PRESETS[presetId],
  images: [],            // {file, name}
  index: -1,
  currentName: '',
  base: null,            // 元画像 (ImageBitmap)
  bitmap: null,          // 回転/反転適用後 (canvas)
  aiBase: null,          // AI入力用の元画像（DICOMのみ。全階調を8bit化したもの。通常画像は null）
  aiBitmap: null,        // aiBase に回転/反転を適用したもの
  imgW:0, imgH:0,
  rotation:0, flipH:false,
  points:{},             // id -> {x,y}
  placedOrder:[],
  radius:60,
  radiusManual:false,     // 大腿骨頭円半径をユーザーが手動調整済みか（自動推定で上書きしないため）
  active:null,
  placingC7:false,
  scale:{ p1:null, p2:null, realMm:null, pxPerMm:null, setting:0 },
  dicomPxPerMm:null,      // DICOMのピクセル間隔タグ由来のスケール（通常画像は null）
  caseId:'',
  rows:[],
  rowByIndex:{},          // 画像index -> rows内の位置（同じ画像の重複記録を防ぐ）
  csvSaved:false,         // rows を CSV 保存済みか（離脱警告の抑制に使用）
  dirty:false,            // 未記録の変更があるか
  result:null,
  view:{ scale:1, ox:0, oy:0 },
  mouseImg:null,
};

//==================================================================
// DOM参照
//==================================================================
export const $ = id=>document.getElementById(id);
export const canvas=$('canvas'), ctx=canvas.getContext('2d');
export const fileInput=$('fileInput');
