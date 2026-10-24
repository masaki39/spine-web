import { G } from './geometry.js';
import { timestamp } from './utils.js';
import { detectCervicalLandmarks } from './cervical-ai.js';
import { detectSpinopelvicLandmarks } from './wholespine-ai.js';

//==================================================================
// プリセット（汎用化の核：ランドマーク・計測・描画・CSVを内包）
//==================================================================
export const SPINOPELVIC = {
  id:'spinopelvic',
  required:['femL','femR','s1a','s1p','l1a','l1p'],
  steps:[
    {id:'femL', label:'左大腿骨頭中心', color:'#ff5252', kind:'circle'},
    {id:'femR', label:'右大腿骨頭中心', color:'#ff5252', kind:'circle'},
    {id:'s1a',  label:'S1 前縁',       color:'#ffeb3b'},
    {id:'s1p',  label:'S1 後縁',       color:'#ffeb3b'},
    {id:'l1a',  label:'L1 前縁',       color:'#ff9800'},
    {id:'l1p',  label:'L1 後縁',       color:'#ff9800'},
    {id:'c7a',  label:'C7 前縁',       color:'#b2ff59', optional:true},
    {id:'c7p',  label:'C7 後縁',       color:'#b2ff59', optional:true},
  ],
  // 終板ラインなど、2点を結ぶ描画（render.js が汎用的に解釈する）。
  // extend:true で区間長ぶんの破線を両端に延長する。
  lines:[
    {a:'s1a', b:'s1p', color:'#00e5ff', extend:true},
    {a:'l1a', b:'l1p', color:'#ff9800', extend:true},
    {a:'c7a', b:'c7p', color:'#b2ff59'},
  ],
  // SVAのようなプラムライン（垂直落下線+水平距離ラベル）。
  // from/to は compute() の結果(res)のフィールド名、なければ配置点(P)のidとして解決する。
  plumbLines:[
    {from:'c7Mid', to:'s1p', color:'#b2ff59', mmKey:'svaMm', pxKey:'svaPx'},
  ],
  // PI/PTの補助線（S1法線・寛骨臼軸線）。点/線の宣言だけでは表せない、この計測固有の幾何。
  drawExtra(H, P, res, ds, k){
    const {dot,line}=H;
    dot(res.s1Mid,5,'#fff');
    const normalLen = res.hipAxis ? G.distance(res.s1Mid,res.hipAxis) : 180*k;
    const end={x:res.s1Mid.x+res.s1Normal.x*normalLen, y:res.s1Mid.y+res.s1Normal.y*normalLen};
    line(res.s1Mid,end,'#fff',2);
    if(res.hipAxis){
      dot(res.hipAxis,5,'#ab47bc');
      line(res.hipAxis,res.s1Mid,'#ab47bc',2);
    }
  },
  metrics:[
    {key:'PI', unit:'°'}, {key:'PT', unit:'°'},
    {key:'SS', unit:'°'}, {key:'LL', unit:'°'},
  ],
  // この計測固有の追加操作（共通ツールバーには置かず、計測値メニューに表示する）。
  // hotkey はグローバルキー配線側でこのプリセットが持つ場合のみ有効になる。
  extras:[
    {id:'scale', label:'📏 スケール', cls:'orange', title:'基準線2点と実長でスケール校正 (S)'},
    {id:'c7',    label:'C7 / SVA',   cls:'teal',   title:'C7前/後縁を配置してSVAを計測 (C)'},
    // AI自動計測（全脊椎2段階モデル）: 頚椎と同じく同意取得前データで学習したモデルのため、
    // 手元での試用（pnpm try-ai）でのみ表示する。
    ...(import.meta.env.VITE_AI
      ? [{id:'aiDetect', label:'🤖 自動計測', cls:'ai', title:'全脊椎AIモデルで大腿骨頭・S1・L1・C7を自動配置（オンライン版のみ）'}]
      : []),
  ],
  // extras の aiDetect が呼ぶ推論。{points: id->{x,y}, warnings: string[]} を返す
  aiDetect: detectSpinopelvicLandmarks,
  // 計測値は符号付き。前後ランドマーク(s1a/s1p, l1a/l1p)から「前方向」を導出するため、
  // 画像の左右反転に依存せず一貫した正負が得られる（絶対値による符号の喪失を解消）。
  compute(P, pxPerMm){
    if(!(P.s1a&&P.s1p)) return null;
    const RAD=180/Math.PI;
    const s1Mid=G.midpoint(P.s1a,P.s1p);

    // 前方が画面右なら +1、左なら -1。S1前縁→後縁の水平変位で決定（L1は体型により逆転しうるため除外）。
    const antSign = Math.sign(P.s1a.x-P.s1p.x) || 1;

    // 終板の水平からの符号付き傾き（前縁が頭側＝正）。dxは常に前方向（正）にとる。
    const incl=(a,p)=>Math.atan2(p.y-a.y, antSign*(a.x-p.x))*RAD;
    const SS=-incl(P.s1a,P.s1p);                  // Sacral Slope

    // 描画用 S1 終板法線（頭側向き）— s1a+s1p で確定
    const s1Vec={x:P.s1p.x-P.s1a.x, y:P.s1p.y-P.s1a.y};
    let n={x:-s1Vec.y, y:s1Vec.x};
    const nn=Math.hypot(n.x,n.y);
    if(nn>0) n={x:n.x/nn, y:n.y/nn};
    if(n.y<0) n={x:-n.x, y:-n.y};

    // Pelvic Tilt / PI — femL+femR が揃ったら計算
    let hipAxis=null, PT=null, PI=null;
    if(P.femL&&P.femR){
      hipAxis=G.midpoint(P.femL,P.femR);
      PT=-Math.atan2(antSign*(s1Mid.x-hipAxis.x), hipAxis.y-s1Mid.y)*RAD;
      PI=PT+SS;                                   // Pelvic Incidence（幾何恒等式 PI=PT+SS）
    }

    // Lumbar Lordosis — l1a+l1p が揃ったら計算
    let LL=null;
    if(P.l1a&&P.l1p) LL=SS+incl(P.l1a,P.l1p);    // Lumbar Lordosis（前弯=正, 後弯=負）

    let svaPx=null, svaMm=null, c7Mid=null;
    if(P.c7a&&P.c7p){
      c7Mid=G.midpoint(P.c7a,P.c7p);
      svaPx=antSign*(c7Mid.x-P.s1p.x);           // C7 が S1 後縁より前方＝正（前方バランス）
      if(pxPerMm&&pxPerMm>0) svaMm=svaPx/pxPerMm;
    }
    const complete=!!(P.femL&&P.femR&&P.s1a&&P.s1p&&P.l1a&&P.l1p);
    return {PI,PT,SS,LL,svaPx,svaMm,hipAxis,s1Mid,s1Normal:n,c7Mid,complete};
  },
  csvColumns:[
    'patient_id','image_name','saved_at',
    'PI_deg','PT_deg','SS_deg','LL_deg','SVA_px','SVA_mm',
    'scale_px_per_mm','scale_real_mm',
    'scale_p1_x','scale_p1_y','scale_p2_x','scale_p2_y',
    'left_femoral_x','left_femoral_y','right_femoral_x','right_femoral_y',
    'common_femoral_radius',
    'S1_anterior_x','S1_anterior_y','S1_posterior_x','S1_posterior_y',
    'L1_anterior_x','L1_anterior_y','L1_posterior_x','L1_posterior_y',
    'C7_anterior_x','C7_anterior_y','C7_posterior_x','C7_posterior_y',
  ],
  csvRow(st, res){
    const f=(v,d=2)=>(v==null||Number.isNaN(v))?'':(+v).toFixed(d);
    const P=st.points, sc=st.scale;
    return [
      st.caseId, st.currentName||'', timestamp(),
      f(res.PI),f(res.PT),f(res.SS),f(res.LL),f(res.svaPx),f(res.svaMm),
      f(sc.pxPerMm,4),f(sc.realMm),
      f(sc.p1&&sc.p1.x),f(sc.p1&&sc.p1.y),f(sc.p2&&sc.p2.x),f(sc.p2&&sc.p2.y),
      f(P.femL&&P.femL.x),f(P.femL&&P.femL.y),f(P.femR&&P.femR.x),f(P.femR&&P.femR.y),
      f(st.radius),
      f(P.s1a&&P.s1a.x),f(P.s1a&&P.s1a.y),f(P.s1p&&P.s1p.x),f(P.s1p&&P.s1p.y),
      f(P.l1a&&P.l1a.x),f(P.l1a&&P.l1a.y),f(P.l1p&&P.l1p.x),f(P.l1p&&P.l1p.y),
      f(P.c7a&&P.c7a.x),f(P.c7a&&P.c7a.y),f(P.c7p&&P.c7p.x),f(P.c7p&&P.c7p.y),
    ];
  },
};

//==================================================================
// 頚椎（Cervical）: ランドマーク定義は masaki39/spine-measure-assist の
// CervicalMeasureAssist（CERVICAL_SET, logic_angles_cervical.py）に準拠。
// 計算式はこのアプリ独自の左右反転不変（antSign）方式で実装し直している
// （SPINOPELVIC と同じ流儀で統一するため。参照実装は反転を想定していない）。
//==================================================================
export const CERVICAL = {
  id:'cervical',
  required:['c2c','c2a','c2p','c7sp','c7ia','c7ip','t1a','t1p'],
  steps:[
    {id:'c2c',  label:'C2 椎体中心',       color:'#00e5ff'},
    {id:'c2a',  label:'C2 下終板 前縁',    color:'#ffeb3b'},
    {id:'c2p',  label:'C2 下終板 後縁',    color:'#ffeb3b'},
    {id:'c7sp', label:'C7 上終板 後縁',    color:'#ff5252'},
    {id:'c7ia', label:'C7 下終板 前縁',    color:'#ff9800'},
    {id:'c7ip', label:'C7 下終板 後縁',    color:'#ff9800'},
    {id:'t1a',  label:'T1 上終板 前縁',    color:'#66bb6a'},
    {id:'t1p',  label:'T1 上終板 後縁',    color:'#66bb6a'},
  ],
  lines:[
    {a:'c2a',  b:'c2p',  color:'#ffeb3b', extend:true},
    {a:'c7ia', b:'c7ip', color:'#ff9800', extend:true},
    {a:'t1a',  b:'t1p',  color:'#66bb6a', extend:true},
  ],
  plumbLines:[
    {from:'c2c', to:'c7sp', color:'#ff8a65', mmKey:'svaMm', pxKey:'svaPx'},
  ],
  metrics:[
    {key:'C2C7_angle', unit:'°'}, {key:'T1S', unit:'°'},
  ],
  extras:[
    {id:'scale', label:'📏 スケール', cls:'orange', title:'基準線2点と実長でスケール校正 (S)'},
    // AI自動計測: 現行モデルは同意取得(オプトアウト)前の患者データで学習したため無効化中。
    // 倫理委員会でオプトアウト取得済みのデータで再学習後、モデル一式(cervical_best.onnx /
    // cervical_best.onnx.data / onnxruntime-webのWASM一式)を apps/cervical/model/ に置き、
    // 下の条件を外すだけで再度使えるようになる（推論ロジックは src/cervical-ai.js に実装済み）。
    // それまでは手元での試用（pnpm try-ai が VITE_AI=1 でビルド）でのみ表示する。
    ...(import.meta.env.VITE_AI
      ? [{id:'aiDetect', label:'🤖 自動計測', cls:'ai', title:'AIモデルで頚椎8点を自動配置（オンライン版のみ）'}]
      : []),
  ],
  aiDetect: async (bitmap, w, h) => ({ points: await detectCervicalLandmarks(bitmap, w, h), warnings: [] }),
  // C2下終板(c2a/c2p)から「前方向」を導出し、左右反転しても一貫した符号になるようにする
  // （SPINOPELVICのS1と同じ考え方）。C2C7_angle = incl(C2) - incl(C7下終板)（前弯=正）、
  // T1S = -incl(T1)（前方が下向き=正、標準的なT1 slopeの符号に合わせて反転）、
  // SVAはC2椎体中心とC7上終板後縁の水平距離（C2が前方=正）。
  compute(P, pxPerMm){
    if(!(P.c2a&&P.c2p)) return null;
    const RAD=180/Math.PI;
    const antSign = Math.sign(P.c2a.x-P.c2p.x) || 1;
    const incl=(a,p)=>Math.atan2(p.y-a.y, antSign*(a.x-p.x))*RAD;

    let C2C7_angle=null;
    if(P.c7ia&&P.c7ip) C2C7_angle = incl(P.c2a,P.c2p) - incl(P.c7ia,P.c7ip);

    let T1S=null;
    if(P.t1a&&P.t1p) T1S = -incl(P.t1a,P.t1p);

    let svaPx=null, svaMm=null;
    if(P.c2c&&P.c7sp){
      svaPx = antSign*(P.c2c.x-P.c7sp.x);
      if(pxPerMm&&pxPerMm>0) svaMm = svaPx/pxPerMm;
    }
    const complete=!!(P.c2c&&P.c2a&&P.c2p&&P.c7sp&&P.c7ia&&P.c7ip&&P.t1a&&P.t1p);
    return {C2C7_angle, T1S, svaPx, svaMm, complete};
  },
  csvColumns:[
    'patient_id','image_name','saved_at',
    'C2C7_angle_deg','T1S_deg','SVA_px','SVA_mm',
    'scale_px_per_mm','scale_real_mm',
    'scale_p1_x','scale_p1_y','scale_p2_x','scale_p2_y',
    'C2_center_x','C2_center_y',
    'C2_anterior_x','C2_anterior_y','C2_posterior_x','C2_posterior_y',
    'C7_sup_posterior_x','C7_sup_posterior_y',
    'C7_inf_anterior_x','C7_inf_anterior_y','C7_inf_posterior_x','C7_inf_posterior_y',
    'T1_anterior_x','T1_anterior_y','T1_posterior_x','T1_posterior_y',
  ],
  csvRow(st, res){
    const f=(v,d=2)=>(v==null||Number.isNaN(v))?'':(+v).toFixed(d);
    const P=st.points, sc=st.scale;
    return [
      st.caseId, st.currentName||'', timestamp(),
      f(res.C2C7_angle),f(res.T1S),f(res.svaPx),f(res.svaMm),
      f(sc.pxPerMm,4),f(sc.realMm),
      f(sc.p1&&sc.p1.x),f(sc.p1&&sc.p1.y),f(sc.p2&&sc.p2.x),f(sc.p2&&sc.p2.y),
      f(P.c2c&&P.c2c.x),f(P.c2c&&P.c2c.y),
      f(P.c2a&&P.c2a.x),f(P.c2a&&P.c2a.y),f(P.c2p&&P.c2p.x),f(P.c2p&&P.c2p.y),
      f(P.c7sp&&P.c7sp.x),f(P.c7sp&&P.c7sp.y),
      f(P.c7ia&&P.c7ia.x),f(P.c7ia&&P.c7ia.y),f(P.c7ip&&P.c7ip.x),f(P.c7ip&&P.c7ip.y),
      f(P.t1a&&P.t1a.x),f(P.t1a&&P.t1a.y),f(P.t1p&&P.t1p.x),f(P.t1p&&P.t1p.y),
    ];
  },
};

export const PRESETS = { spinopelvic: SPINOPELVIC, cervical: CERVICAL };
