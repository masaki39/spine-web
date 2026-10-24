import { state, $, canvas, fileInput } from './state.js';
import { G } from './geometry.js';
import { fileStamp, csvEsc, download, deriveId } from './utils.js';
import { render, fit, zoomAt, toScreen, toImg, measurementBlob } from './render.js';
import { isDicom, decodeDicom } from './dicom.js';

// タッチ端末では文言を「タップ」「ボタン名」ベースにする（ホットキーが無いため）
const TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;
const TAP = TOUCH ? 'タップ' : 'クリック';

//==================================================================
// 画像読み込み・回転
//==================================================================
async function setFiles(files){
  // DICOMは拡張子なし（FILE1等）も多いので、画像MIME以外は中身を見て判定する
  const kinds=await Promise.all([...files].map(async f=>
    f.type.startsWith('image/') ? {file:f, dicom:false} : (await isDicom(f)) ? {file:f, dicom:true} : null));
  const imgs=kinds.filter(Boolean)
                  .sort((a,b)=>a.file.name.localeCompare(b.file.name, undefined, {numeric:true}));
  if(!imgs.length){ setStatus('画像またはDICOMファイルが見つかりません', 4000); return; }
  const lose=[];
  if(state.rows.length && !state.csvSaved) lose.push(`未保存のCSV記録（${state.rows.length}件）`);
  if(hasUnsaved()) lose.push('配置中の点');
  if(lose.length && !confirm(`${lose.join('と')}が失われます。新しい画像を開きますか？`)) return;
  state.images=imgs.map(({file,dicom})=>({file, name:file.name, dicom}));
  state.rows=[]; state.rowByIndex={}; state.csvSaved=false;   // 新しいバッチ＝記録をリセット
  loadImage(0);
}

let _loadToken=0;
async function loadImage(i){
  if(i<0||i>=state.images.length) return;
  const token=++_loadToken;
  const it=state.images[i];
  let base, aiBase=null, dicomPxPerMm=null;
  try{
    if(it.dicom) ({ canvas:base, aiCanvas:aiBase, pxPerMm:dicomPxPerMm }=await decodeDicom(it.file));
    else base=await createImageBitmap(it.file);
  }catch(err){
    console.error(err);
    if(token===_loadToken) setStatus(`${it.name} を開けません: ${err.message}`, 8000);
    return;
  }
  if(token!==_loadToken) return;        // 連打で追い越された読み込みは破棄
  state.index=i; state.currentName=it.name; state.base=base; state.aiBase=aiBase; state.dicomPxPerMm=dicomPxPerMm;
  state.rotation=0; state.flipH=false;
  buildWorking();
  resetPoints();
  $('caseId').value = state.caseId = deriveId(it.name);
  fit(); updateUI(); render();
  if(dicomPxPerMm) setStatus(`DICOMのピクセル間隔からスケールを自動設定（1mm = ${dicomPxPerMm.toFixed(2)}px）`, 5000);
}

function buildWorking(){
  const r=((state.rotation%360)+360)%360;
  const swap=(r===90||r===270);
  const bw=state.base.width, bh=state.base.height;
  const w=swap?bh:bw, h=swap?bw:bh;
  const transformed=src=>{
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    const x=c.getContext('2d');
    x.save();
    x.translate(w/2,h/2);
    x.rotate(r*Math.PI/180);
    if(state.flipH) x.scale(-1,1);
    x.drawImage(src, -bw/2, -bh/2);
    x.restore();
    return c;
  };
  state.bitmap=transformed(state.base); state.imgW=w; state.imgH=h;
  state.aiBitmap=state.aiBase ? transformed(state.aiBase) : null;
}

function resetPoints(){
  state.points={}; state.placedOrder=[]; state.radius=60; state.radiusManual=false;
  state.active=null; state.placingC7=false; state.result=null; state.dirty=false;
  // DICOMはピクセル間隔タグのスケールを初期値にする（手動校正すればそちらで上書き）
  state.scale={ p1:null, p2:null, realMm:null, pxPerMm:state.dicomPxPerMm, setting:0 };
}

function rotate(deg){
  if(!state.base) return;
  if(hasUnsaved() && !confirm('回転すると配置済みの点・スケールが失われます。続けますか？')) return;
  state.rotation+=deg; buildWorking(); resetPoints(); fit(); recompute(); updateUI(); render();
}
function flip(){
  if(!state.base) return;
  if(hasUnsaved() && !confirm('反転すると配置済みの点・スケールが失われます。続けますか？')) return;
  state.flipH=!state.flipH; buildWorking(); resetPoints(); fit(); recompute(); updateUI(); render();
}

//==================================================================
// 計測・記録
//==================================================================
function recompute(){ state.result=state.preset.compute(state.points, state.scale.pxPerMm); }
function recalcScale(){
  const sc=state.scale;
  if(sc.p1&&sc.p2&&sc.realMm) sc.pxPerMm=G.distance(sc.p1,sc.p2)/sc.realMm;
}
function pendingStepId(){
  for(const id of state.preset.required) if(!state.points[id]) return id;
  if(state.placingC7){ if(!state.points.c7a) return 'c7a'; if(!state.points.c7p) return 'c7p'; }
  return null;
}
const labelOf = id => (state.preset.steps.find(s=>s.id===id)||{}).label||id;

function place(id, p){
  state.points[id]=p; state.placedOrder.push(id); state.active=id; state.dirty=true;
  if(id==='femR'&&state.points.femL&&!state.radiusManual){
    const est=G.distance(state.points.femL, state.points.femR)/4;
    state.radius=Math.max(20, Math.min(120, est));
  }
  if(id==='c7p') state.placingC7=false;
  recompute();
}
function undo(){
  // C7配置中でまだC7点が無い場合はモード終了のみ（無関係な点を消さない）
  if(state.placingC7 && !state.points.c7a && !state.points.c7p){
    state.placingC7=false; setStatus('C7入力を中止しました', 3000); updateUI(); render(); return;
  }
  const id=state.placedOrder.pop();
  if(!id) return;
  delete state.points[id];
  if(id==='c7a'||id==='c7p') state.placingC7=true;   // C7点の取消は置き直しモードを維持
  state.active=state.placedOrder[state.placedOrder.length-1]||null;
  state.dirty=true; recompute(); updateUI(); render();
}

function hasUnsaved(){ return state.dirty && state.placedOrder.length>0; }
function navTo(i){
  if(i<0||i>=state.images.length) return;
  if(hasUnsaved() && !confirm('未記録の変更があります。記録せずに移動しますか？')) return;
  loadImage(i);
}

async function recordAndNext(){
  recompute();
  if(!state.result?.complete){ setStatus('必須点（大腿骨頭L/R・S1・L1）が未配置です', 4000); return; }
  state.caseId=$('caseId').value.trim();
  const row=state.preset.csvRow(state, state.result);
  const pos=state.rowByIndex[state.index];
  if(pos!==undefined){ state.rows[pos]=row; }          // 同じ画像の再記録は置換
  else { state.rowByIndex[state.index]=state.rows.length; state.rows.push(row); }
  state.dirty=false; state.csvSaved=false;

  if(state.index < state.images.length-1){
    loadImage(state.index+1);
  }else{
    setStatus(`全画像の記録完了（計 ${state.rows.length} 件）。${TOUCH?'「CSV保存」':'CSV保存(D)'}で書き出せます。`, 10000);
    updateUI();
  }
}

//==================================================================
// CSV / ファイル出力
//==================================================================
function csvText(rows){
  return [state.preset.csvColumns, ...rows].map(r=>r.map(csvEsc).join(',')).join('\r\n');
}
function csvBlob(rows){ return new Blob(['﻿'+csvText(rows)], {type:'text/csv;charset=utf-8'}); }
function saveCsv(){
  if(!state.rows.length){
    setStatus(TOUCH ? '記録がありません（「記録して次へ」で記録してから保存）'
                    : '記録がありません（Enterで記録してから保存）', 4000);
    return;
  }
  download(csvBlob(state.rows), `spinopelvic_batch_${fileStamp()}.csv`);
  state.csvSaved=true;
}
async function saveMeasurementImage(){
  if(!state.bitmap) return;
  if(!state.result){ setStatus('計測値がありません（ランドマークを配置してください）', 4000); return; }
  const base=(state.caseId||state.currentName||'case').replace(/[\\/:*?"<>| ]/g,'_');
  download(await measurementBlob(), `${base}_measured.png`);
}

//==================================================================
// ヒットテスト・ポインタ操作
//==================================================================
// preset.steps のうち kind:'circle' な点（大腿骨頭のような半径ハンドル付き円）のid一覧
const circleStepIds = ()=> state.preset.steps.filter(s=>s.kind==='circle').map(s=>s.id);

function hitTest(sp, thr=10){
  const P=state.points;
  for(const id of circleStepIds()){
    const center=P[id]; if(!center) continue;
    const h=toScreen({x:center.x+state.radius, y:center.y});
    if(Math.hypot(sp.x-h.x,sp.y-h.y)<thr) return {type:'radius', id};
  }
  for(const s of state.preset.steps){ const p=P[s.id]; if(!p) continue;
    const c=toScreen(p); if(Math.hypot(sp.x-c.x,sp.y-c.y)<thr) return {type:'point', id:s.id}; }
  for(const [id,p] of [['scale1',state.scale.p1],['scale2',state.scale.p2]]){ if(!p) continue;
    const c=toScreen(p); if(Math.hypot(sp.x-c.x,sp.y-c.y)<thr) return {type:id}; }
  return null;
}
function applyDrag(hit, ip){
  const P=state.points, sc=state.scale;
  state.dirty=true;
  switch(hit.type){
    case 'point': P[hit.id]=ip; state.active=hit.id; break;
    case 'radius': if(P[hit.id]){ state.radius=Math.max(10,G.distance(ip,P[hit.id])); state.radiusManual=true; } break;
    case 'scale1': sc.p1=ip; recalcScale(); break;
    case 'scale2': sc.p2=ip; recalcScale(); break;
  }
  recompute();
}
// ピンチ開始時にドラッグを巻き戻すためのスナップショット
function dragSnapshot(hit){
  if(!hit) return null;
  const P=state.points, sc=state.scale;
  switch(hit.type){
    case 'point': return {p:{...P[hit.id]}};
    case 'radius': return {r:state.radius, manual:state.radiusManual};
    case 'scale1': return {p:sc.p1&&{...sc.p1}, mm:sc.pxPerMm};
    case 'scale2': return {p:sc.p2&&{...sc.p2}, mm:sc.pxPerMm};
    default: return null;
  }
}
function dragRollback(hit, snap){
  if(!hit||!snap) return;
  const P=state.points, sc=state.scale;
  switch(hit.type){
    case 'point': P[hit.id]=snap.p; break;
    case 'radius': state.radius=snap.r; state.radiusManual=snap.manual; break;
    case 'scale1': sc.p1=snap.p; sc.pxPerMm=snap.mm; break;
    case 'scale2': sc.p2=snap.p; sc.pxPerMm=snap.mm; break;
  }
  recompute();
}
function scaleTap(ip){
  const sc=state.scale;
  if(sc.setting===1){ sc.p1=ip; sc.setting=2; setStatus(`スケール: 基準線の終点を${TAP}`); }
  else if(sc.setting===2){
    sc.p2=ip; sc.setting=0;
    const v=prompt('基準線の実長 (mm) を入力', '100');
    const mm=parseFloat(v);
    if(mm>0){ sc.realMm=mm; recalcScale(); state.dirty=true; setStatus(`スケール設定: 1mm = ${sc.pxPerMm.toFixed(2)}px`, 5000); }
    else { sc.p1=null; sc.p2=null; setStatus('スケール校正をキャンセルしました', 3000); }
    recompute();
  }
}
function placeOrSelect(ip){
  const pid=pendingStepId();
  if(pid){ place(pid, ip); return; }
  // 最近傍点を選択（近くに無ければ選択解除 → 微調整パッドも閉じる）
  let best=null, bd=20;
  for(const s of state.preset.steps){ const p=state.points[s.id]; if(!p) continue;
    const c=toScreen(p), d=Math.hypot(c.x-toScreen(ip).x, c.y-toScreen(ip).y); if(d<bd){ bd=d; best=s.id; } }
  state.active=best;
}

let down=null;
const pointers=new Map();   // pointerId -> {x,y}（ピンチズーム用）
let pinch=null;
canvas.addEventListener('pointerdown', e=>{
  if(!state.bitmap) return;
  // モバイル: 計測値シートを開いたままステージをタップ → シートを閉じるだけ
  if(document.body.classList.contains('panel-open')){ togglePanel(); return; }
  try{ canvas.setPointerCapture(e.pointerId); }catch{}
  const sp={x:e.offsetX,y:e.offsetY};
  pointers.set(e.pointerId, sp);
  if(pointers.size===2){                 // 2本指 → ピンチズーム開始（配置/ドラッグは中断して巻き戻す）
    if(down&&down.hit) dragRollback(down.hit, down.orig);
    down=null; state.mouseImg=null;
    const [a,b]=[...pointers.values()];
    pinch={ dist:Math.hypot(a.x-b.x,a.y-b.y), scale:state.view.scale,
            mid:{x:(a.x+b.x)/2, y:(a.y+b.y)/2} };
    document.body.classList.add('dragging');
    render(); return;
  }
  const hit=hitTest(sp, e.pointerType==='touch'?24:10);   // 指では判定を広めに
  down={sx:sp.x, sy:sp.y, hit, orig:dragSnapshot(hit), moved:0, ox:state.view.ox, oy:state.view.oy};
});
canvas.addEventListener('pointermove', e=>{
  const sp={x:e.offsetX,y:e.offsetY};
  if(pointers.has(e.pointerId)) pointers.set(e.pointerId, sp);
  if(pinch && pointers.size>=2){
    const [a,b]=[...pointers.values()];
    const dist=Math.hypot(a.x-b.x,a.y-b.y);
    const mid={x:(a.x+b.x)/2, y:(a.y+b.y)/2};
    const v=state.view;
    v.ox+=mid.x-pinch.mid.x; v.oy+=mid.y-pinch.mid.y;   // 2本指の平行移動でパン
    if(pinch.dist>0) zoomAt(mid.x, mid.y, (pinch.scale*dist/pinch.dist)/v.scale);
    pinch.mid=mid;
    return;
  }
  if(state.bitmap) state.mouseImg=toImg(sp);
  if(down){
    const dx=sp.x-down.sx, dy=sp.y-down.sy;
    down.moved=Math.max(down.moved, Math.hypot(dx,dy));
    // タップ閾値(5px)を超えるまではドラッグを発動しない
    // （クリック時の微小ジッタで既存点が動き、タップ配置と重畳するのを防ぐ）
    if(down.moved>=5){
      document.body.classList.add('dragging');   // HUDを退避
      if(down.hit) applyDrag(down.hit, toImg(sp));
      else { state.view.ox=down.ox+dx; state.view.oy=down.oy+dy; state.view.custom=true; }
    }
  }
  render();
  if(down) updateUI();
});
function endPointer(e){
  pointers.delete(e.pointerId);
  if(pinch && pointers.size<2) pinch=null;
  if(pointers.size===0) document.body.classList.remove('dragging');
}
canvas.addEventListener('pointerup', e=>{
  endPointer(e);
  if(e.pointerType==='touch') state.mouseImg=null;   // タッチ後にルーペを残さない
  if(!down){ render(); return; }
  const sp={x:e.offsetX,y:e.offsetY}, ip=toImg(sp), tap=down.moved<5;
  if(state.scale.setting>0 && tap) scaleTap(ip);
  else if(tap){
    // 配置すべき点が残っている間はタップ＝配置を最優先（既存点の近くでも奪わせない）
    if(pendingStepId()) placeOrSelect(ip);
    else if(down.hit&&down.hit.type==='point') state.active=down.hit.id;
    else if(!down.hit) placeOrSelect(ip);
  }
  down=null; updateUI(); render();
});
canvas.addEventListener('pointercancel', e=>{
  endPointer(e); down=null; state.mouseImg=null; render();
});
canvas.addEventListener('pointerleave', ()=>{ state.mouseImg=null; render(); });
canvas.addEventListener('wheel', e=>{ if(!state.bitmap) return; e.preventDefault();
  zoomAt(e.offsetX, e.offsetY, e.deltaY<0?1.1:1/1.1); }, {passive:false});

//==================================================================
// キーボード
//==================================================================
function nudge(dx,dy){
  if(!state.active||!state.points[state.active]) return;
  const p=state.points[state.active]; p.x+=dx; p.y+=dy; state.dirty=true; recompute(); updateUI(); render();
}
window.addEventListener('keydown', e=>{
  const inField = document.activeElement && document.activeElement.tagName==='INPUT';
  if(inField){
    if(e.key==='Escape') document.activeElement.blur();
    else if(e.key==='Enter' && document.activeElement.id==='caseId'){
      e.preventDefault(); document.activeElement.blur(); recordAndNext();   // ID修正→Enterで記録
    }
    return;
  }
  if(e.metaKey||e.ctrlKey) return;        // ブラウザのCmd/Ctrlショートカットを優先
  if($('help').classList.contains('show')){   // ヘルプ表示中はキー操作を遮断
    if(['Escape','?','h','H'].includes(e.key)) closeHelp();
    else if(e.key==='Tab'){ e.preventDefault(); $('helpClose').focus(); }   // ダイアログ外へ抜けない
    return;
  }
  const step = e.shiftKey?5 : (e.altKey?0.2 : 1);
  switch(e.key){
    case 'o': case 'O': fileInput.click(); break;
    case 'r': rotate(90); break;
    case 'R': rotate(-90); break;
    case 'f': case 'F': flip(); break;
    case 'z': case 'Z': case 'Backspace': e.preventDefault(); undo(); break;
    case 'c': case 'C': if(hasExtra('c7')) startC7(); break;
    case 's': case 'S': if(hasExtra('scale')) startScale(); break;
    case 'Enter': case 'e': case 'E': e.preventDefault(); recordAndNext(); break;
    case 'n': case 'N': navTo(state.index+1); break;
    case 'p': case 'P': navTo(state.index-1); break;
    case 'd': case 'D': saveCsv(); break;
    case '+': case '=': zoomAt(canvas.clientWidth/2, canvas.clientHeight/2, 1.2); break;
    case '-': case '_': zoomAt(canvas.clientWidth/2, canvas.clientHeight/2, 1/1.2); break;
    case '0': fit(); render(); break;
    case 'ArrowLeft':  e.preventDefault(); nudge(-step,0); break;
    case 'ArrowRight': e.preventDefault(); nudge(step,0); break;
    case 'ArrowUp':    e.preventDefault(); nudge(0,-step); break;
    case 'ArrowDown':  e.preventDefault(); nudge(0,step); break;
    case '?': case 'h': case 'H': toggleHelp(); break;
    case 'Escape':
      if(state.scale.setting) startScale();          // 校正中止（トグル）
      else if(state.placingC7) startC7();            // C7入力中止（トグル）
      closeHelp();
      break;
  }
});

function startC7(){
  if(state.placingC7){   // モード中にもう一度押すと中止
    state.placingC7=false;
    delete state.points.c7a; delete state.points.c7p;
    state.placedOrder=state.placedOrder.filter(id=>id!=='c7a'&&id!=='c7p');
    recompute(); setStatus('C7入力を中止しました', 3000); updateUI(); render(); return;
  }
  if(!state.result?.complete){ setStatus('先にPI/PT/SS/LL計測を完了してください'); return; }
  state.placingC7=true;
  delete state.points.c7a; delete state.points.c7p;
  state.placedOrder=state.placedOrder.filter(id=>id!=='c7a'&&id!=='c7p');
  state.active=null;
  setStatus(`C7前縁→C7後縁を${TAP}（SVA算出）`); updateUI(); render();
}
function startScale(){
  if(!state.bitmap) return;
  if(state.scale.setting>0){   // モード中にもう一度押すと中止
    state.scale.setting=0; state.scale.p1=null; state.scale.p2=null;
    recompute(); setStatus('スケール校正を中止しました', 3000); updateUI(); render(); return;
  }
  state.scale={ p1:null,p2:null,realMm:null,pxPerMm:state.dicomPxPerMm, setting:1 };
  recompute(); setStatus(`スケール: 基準線の始点を${TAP}（もう一度押すと中止）`); updateUI(); render();
}

// AIモデルでプリセットの計測点を自動配置（推論は preset.aiDetect。オンライン版のみ。ローカル単体HTMLでは
// モデルが同梱されないため fetch が失敗し、その場合はエラー表示のみで他機能には影響しない）
let aiBusy=false;
async function autoDetect(){
  if(!state.bitmap || aiBusy) return;
  aiBusy=true;
  const btn=document.getElementById('extra-aiDetect');
  const label=btn?.querySelector('.bl');
  const prevLabel=label?.textContent;
  if(btn) btn.disabled=true;
  if(label) label.textContent='⏳ 解析中…';
  setStatus('AIで計測点を自動配置中…（初回はモデル読込のため時間がかかります）');
  try{
    const {points:detected, warnings}=await state.preset.aiDetect(state.aiBitmap||state.bitmap, state.imgW, state.imgH);
    state.placingC7=false;
    for(const [id,p] of Object.entries(detected)){
      if(!state.placedOrder.includes(id)) state.placedOrder.push(id);
      state.points[id]=p;
    }
    state.active=null; state.dirty=true;
    recompute();
    setStatus(warnings.length
      ? `AIで自動配置しました（要確認: ${warnings.join('、')}）。点はドラッグ/矢印キーで微調整できます。`
      : 'AIで自動配置しました。点はドラッグ/矢印キーで微調整できます。', warnings.length?10000:6000);
  }catch(err){
    console.error(err);
    setStatus('自動計測は利用できません（オンライン版でのみ利用可能です）', 6000);
  }finally{
    aiBusy=false;
    if(btn) btn.disabled=!state.bitmap;
    if(label) label.textContent=prevLabel;
    updateUI(); render();
  }
}

//==================================================================
// 計測値メニュー（プリセット固有の追加操作。共通ツールバーには置かない）
//==================================================================
// プリセットの extras（preset.js）を id で実際の挙動に紐付けるレジストリ。
// 新しいプリセットが別の extras を宣言しても、この対応表を増やすだけでよい。
const EXTRA_ACTIONS = {
  scale:{ run:startScale, on:()=>state.scale.setting>0 },
  c7:{ run:startC7, on:()=>state.placingC7 },
  aiDetect:{ run:autoDetect, on:()=>false },
};
const extrasOf = ()=> state.preset.extras||[];
function hasExtra(id){ return extrasOf().some(x=>x.id===id); }
function renderExtras(){
  const el=$('extras'); if(!el) return;
  el.innerHTML = extrasOf().map(x=>
    `<button class="dataonly ${x.cls||''}" id="extra-${x.id}" title="${x.title||x.label}"><span class="bl">${x.label}</span></button>`
  ).join('');
  for(const x of extrasOf()){
    document.getElementById(`extra-${x.id}`).onclick = ()=>EXTRA_ACTIONS[x.id]?.run();
  }
}

//==================================================================
// UI 更新
//==================================================================
// holdMs を指定すると、その間 updateUI の自動ガイダンスに上書きされない
// （完了・中止などの一時メッセージ用。明示的な setStatus は常に優先される）
let statusHoldUntil=0;
function setStatus(t, holdMs=0){
  $('status').textContent=t;
  statusHoldUntil = holdMs ? Date.now()+holdMs : 0;
}
function updateUI(){
  const has=!!state.bitmap;
  $('empty').style.display = has ? 'none' : 'flex';
  $('zoomctl').style.display = has ? '' : 'none';
  document.querySelectorAll('.dataonly').forEach(b=>b.disabled=!has);
  $('btnPrev').disabled=!has||state.index<=0;
  $('btnNext').disabled=!has||state.index>=state.images.length-1;
  $('navPrev').disabled=!has||state.index<=0;
  $('navNext').disabled=!has||state.index>=state.images.length-1;
  const rec = has && state.rowByIndex[state.index]!==undefined;
  $('counter').hidden = !has;
  $('counter').textContent = has
    ? `画像 ${state.index+1} / ${state.images.length}` + (rec?' ✓記録済':'') + (hasUnsaved()?' ●未記録':'')
    : '画像なし';

  // 計測値
  const res=state.result, m=$('metrics');
  if(res){
    m.innerHTML = state.preset.metrics.map(mt=>{
      const v=res[mt.key];
      const display = v!=null ? `${v.toFixed(1)}${mt.unit}` : '-';
      return `<div class="metric"><div class="k">${mt.key}</div><div class="v">${display}</div></div>`;
    }).join('');
    const sv=$('svaInfo');
    if(res.svaPx!=null){
      const val = res.svaMm!=null
        ? `${res.svaMm.toFixed(1)}<span class="mu">mm</span>`
        : `${res.svaPx.toFixed(1)}<span class="mu">px</span>`;
      const sub = res.svaMm!=null ? `${res.svaPx.toFixed(1)} px` : 'mm換算はスケール校正が必要';
      sv.innerHTML = `<div class="metric svawide"><div class="k">SVA</div><div class="v">${val}</div><div class="sub">${sub}</div></div>`;
    } else {
      const hint = hasExtra('c7') ? `（${TOUCH?'C7 / SVAボタンで配置':'C入力でC7配置'}）` : '';
      sv.innerHTML = `<div class="note" style="color:#999">SVA未計測${hint}</div>`;
    }
  } else {
    m.innerHTML = `<div class="note" style="grid-column:1/3">必須点を配置すると計測値が表示されます。</div>`;
    $('svaInfo').innerHTML='';
  }

  // 計測値メニューの追加操作ボタン: モード中は「中止」に切替
  for(const x of extrasOf()){
    const btn=document.getElementById(`extra-${x.id}`); if(!btn) continue;
    const on = !!EXTRA_ACTIONS[x.id]?.on();
    btn.classList.toggle('modeon', on);
    btn.querySelector('.bl').textContent = on ? '✕ 中止' : x.label;
  }

  // ステータス（校正中・一時メッセージ表示中でなければ）
  if(Date.now()<statusHoldUntil){
    // 完了/中止などの一時メッセージを保持
  }else if(!has){
    setStatus(TOUCH ? '画像を選択して計測を開始' : '画像を開いて計測を開始（O）');
  }else if(state.scale.setting===0){
    const pid=pendingStepId();
    if(pid){
      setStatus(TOUCH ? `次: ${labelOf(pid)} をタップ`
                      : `次: ${labelOf(pid)} をクリック（配置後は矢印キーで微調整）`);
    }else if(TOUCH && res){
      // タッチ端末はサイドバーが隠れているため、主要値をピルに常時表示
      const fm=v=>v==null?'—':v.toFixed(1);
      setStatus(`PI ${fm(res.PI)}° ／ PT ${fm(res.PT)}° ／ SS ${fm(res.SS)}° ／ LL ${fm(res.LL)}° — 「記録して次へ」で保存`);
    }else{
      setStatus('計測完了。Enter/Eで記録して次へ。点はドラッグで調整可。');
    }
  }

  renderSteps();
  updateNudgepad();
}

// ランドマーク進捗リスト（配置済み✓ / 次● / 未配置）。配置済みは押すと選択。
function renderSteps(){
  const ol=$('steps'); if(!ol) return;
  const has=!!state.bitmap;
  const pid=has ? pendingStepId() : null;
  ol.innerHTML = state.preset.steps.map(s=>{
    const placed=!!state.points[s.id];
    const c7ready=has && !placed && s.optional && state.result?.complete && !state.placingC7;
    const cls=['', placed?'done':(s.id===pid?'next':'todo'),
               state.active===s.id?'sel':'', c7ready?'ready':''].join(' ').trim();
    const st = placed ? (state.active===s.id?'選択中':'✓')
                      : (s.id===pid?'●':(c7ready?'＋開始':(s.optional?'任意':'')));
    return `<li class="${cls}" data-id="${s.id}">
      <span class="dotc" style="background:${s.color}"></span>
      <span class="lbl">${s.label}</span><span class="st">${st}</span></li>`;
  }).join('');
}

// タッチ用微調整パッド: 点を選択中のみ表示
function updateNudgepad(){
  const el=$('nudgepad'); if(!el) return;
  const show = !!(state.bitmap && state.active && state.points[state.active]);
  el.classList.toggle('show', show);
  if(show) $('nudgeLabel').textContent = labelOf(state.active);
}

//==================================================================
// ヘルプ
//==================================================================
function openHelp(){ $('help').classList.add('show'); $('helpClose').focus(); }
function closeHelp(){
  if(!$('help').classList.contains('show')) return;
  $('help').classList.remove('show'); $('btnHelp').focus();
}
function toggleHelp(){ $('help').classList.contains('show') ? closeHelp() : openHelp(); }
const hotkeyTable = `
  <h3>ホットキー</h3>
  <table>
    <tr><td><kbd>O</kbd></td><td>画像を開く（複数選択可）</td><td><kbd>R</kbd> / <kbd>⇧R</kbd></td><td>右/左90°回転</td></tr>
    <tr><td><kbd>F</kbd></td><td>左右反転</td><td><kbd>S</kbd></td><td>スケール校正</td></tr>
    <tr><td>クリック</td><td>現在のランドマークを配置</td><td>ドラッグ</td><td>点の移動 / 余白でパン</td></tr>
    <tr><td>矢印</td><td>選択点を微調整 (1px)</td><td><kbd>⇧</kbd>+矢印 / <kbd>⌥</kbd>+矢印</td><td>5px / 0.2px</td></tr>
    <tr><td><kbd>Z</kbd> / <kbd>⌫</kbd></td><td>直前の点を取消</td><td><kbd>C</kbd></td><td>C7入力（SVA）</td></tr>
    <tr><td><kbd>Enter</kbd> / <kbd>E</kbd></td><td>記録して次の画像へ</td><td><kbd>N</kbd> / <kbd>P</kbd></td><td>次 / 前の画像</td></tr>
    <tr><td><kbd>D</kbd></td><td>蓄積CSVを保存</td><td><kbd>+</kbd>/<kbd>-</kbd>/<kbd>0</kbd></td><td>ズーム / フィット</td></tr>
    <tr><td>ホイール</td><td>カーソル位置でズーム</td><td><kbd>?</kbd></td><td>このヘルプ</td></tr>
  </table>`;
const touchTable = `
  <h3>タッチ操作</h3>
  <table>
    <tr><td>タップ</td><td>現在のランドマークを配置 / 点を選択</td></tr>
    <tr><td>ドラッグ</td><td>点の移動 ／ 余白で画像をパン</td></tr>
    <tr><td>ピンチ</td><td>2本指でズーム</td></tr>
    <tr><td>＋ / － / ⊡</td><td>ズームイン / アウト / 全体表示</td></tr>
    <tr><td>↩</td><td>直前の点を取消</td></tr>
    <tr><td>▲◀▶▼</td><td>選択中の点を1pxずつ微調整（右下のパッド）</td></tr>
  </table>`;
$('help').innerHTML = `
  <div class="helpbox">
    <h2>Spinopelvic Analyzer — 使い方 <button id="helpClose" aria-label="閉じる">✕</button></h2>
    <ol class="flow">
      <li>「画像を開く」でX線画像を選択（複数選択可）</li>
      <li>ガイドに従い${TAP}で配置: 左右大腿骨頭中心 → S1前/後縁 → L1前/後縁</li>
      <li>点はドラッグで微調整${TOUCH?'（右下の矢印パッドで1pxずつ調整可）':'（矢印キー=1px, ⇧=5px, ⌥=0.2px）'}</li>
      <li>必要に応じて「📏 スケール」で実寸校正、「C7 / SVA」でSVA計測</li>
      <li>「記録して次へ」で結果を蓄積 → 最後に「CSV保存」で一括出力</li>
    </ol>
    ${TOUCH ? touchTable : hotkeyTable}
    <p class="closeHint">背景を${TAP}するか ✕ で閉じる</p>
  </div>`;
// 背景クリックまたは✕で閉じる（本文はテキスト選択できるよう閉じない）
$('help').addEventListener('click', e=>{
  if(e.target.id==='help' || e.target.closest('#helpClose')) closeHelp();
});

//==================================================================
// ボタン・入力配線
//==================================================================
$('btnOpen').onclick=()=>fileInput.click();
document.querySelector('#empty .dropbox').onclick=()=>fileInput.click();
document.querySelector('#empty .dropbox').addEventListener('keydown', e=>{
  if(e.key==='Enter'||e.key===' '){ e.preventDefault(); fileInput.click(); }
});
fileInput.onchange=e=>{ if(e.target.files.length) setFiles(e.target.files); };
$('btnRotL').onclick=()=>rotate(-90);
$('btnRotR').onclick=()=>rotate(90);
$('btnFlip').onclick=flip;
renderExtras();
$('btnUndo').onclick=undo;
$('btnRecord').onclick=recordAndNext;
$('btnPrev').onclick=()=>navTo(state.index-1);
$('btnNext').onclick=()=>navTo(state.index+1);
$('btnCsv').onclick=saveCsv;
$('btnSaveImg').onclick=saveMeasurementImage;
$('btnHelp').onclick=toggleHelp;
// モバイル: 計測値ボトムシートの開閉
function togglePanel(){
  const open=document.body.classList.toggle('panel-open');
  $('navPanel').textContent = open ? '✕ 閉じる' : '📊 計測値';
  $('navPanel').setAttribute('aria-expanded', String(open));
}
$('navPanel').onclick = togglePanel;
$('backdrop').onclick = ()=>{ if(document.body.classList.contains('panel-open')) togglePanel(); };
$('navPrev').onclick   = ()=>navTo(state.index-1);
$('navNext').onclick   = ()=>navTo(state.index+1);
$('navRecord').onclick = recordAndNext;
// タッチ端末: オンスクリーンのズーム/フィット/取消（ホットキーの代替）
$('btnZoomIn').onclick =()=>zoomAt(canvas.clientWidth/2, canvas.clientHeight/2, 1.25);
$('btnZoomOut').onclick=()=>zoomAt(canvas.clientWidth/2, canvas.clientHeight/2, 1/1.25);
$('btnFit').onclick    =()=>{ fit(); render(); };
$('btnUndoFloat').onclick=undo;

// タッチ端末: 選択点の1px微調整パッド（長押しでリピート）
let nudgeTimer=null;
document.querySelectorAll('#nudgepad .pad button').forEach(b=>{
  const dx=+b.dataset.dx, dy=+b.dataset.dy;
  b.addEventListener('pointerdown', e=>{
    e.preventDefault(); nudge(dx,dy);
    nudgeTimer=setTimeout(function rep(){ nudge(dx,dy); nudgeTimer=setTimeout(rep,90); },350);
  });
  ['pointerup','pointerleave','pointercancel'].forEach(ev=>
    b.addEventListener(ev, ()=>clearTimeout(nudgeTimer)));
});
$('nudgeClose').onclick=()=>{ state.active=null; updateUI(); render(); };

// ランドマークリスト: 配置済みは選択、C7は未配置でも開始できる
$('steps').addEventListener('click', e=>{
  const li=e.target.closest('li[data-id]'); if(!li||!state.bitmap) return;
  const id=li.dataset.id;
  if(state.points[id]){ state.active=id; updateUI(); render(); }
  else if((id==='c7a'||id==='c7p') && state.result?.complete && !state.placingC7) startC7();
});

// モバイル: ツールバーが右端までスクロールされたらフェードを消す
{
  const tb=$('toolbar');
  const updTb=()=>tb.classList.toggle('scroll-end', tb.scrollLeft+tb.clientWidth>=tb.scrollWidth-4);
  tb.addEventListener('scroll', updTb, {passive:true});
  window.addEventListener('resize', updTb);
  updTb();
}
$('caseId').oninput=e=>state.caseId=e.target.value;

// ドラッグ&ドロップ
['dragover','drop'].forEach(ev=>document.addEventListener(ev, e=>e.preventDefault()));
document.addEventListener('drop', e=>{
  const items=e.dataTransfer.files; if(items&&items.length) setFiles(items);
});

// リサイズ: ユーザーがズーム/パン済みなら中心を保って維持（モバイルのキーボード表示等で
// 拡大状態を破棄しない）。フィット状態のままなら追従して再フィット。
let lastCW=0, lastCH=0;
function onResize(){
  const cw=canvas.clientWidth, ch=canvas.clientHeight;
  if(state.bitmap){
    const v=state.view;
    if(!v.custom){ fit(); }
    else if(lastCW&&lastCH){
      const cx=(lastCW/2-v.ox)/v.scale, cy=(lastCH/2-v.oy)/v.scale;
      v.ox=cw/2-cx*v.scale; v.oy=ch/2-cy*v.scale;
    }
  }
  lastCW=cw; lastCH=ch; render();
}
window.addEventListener('resize', onResize);

// 未保存データがある間はリロード/タブ閉鎖の前に警告
window.addEventListener('beforeunload', e=>{
  if((state.rows.length && !state.csvSaved) || hasUnsaved()){
    e.preventDefault(); e.returnValue='';
  }
});

$('empty').style.display='flex';
updateUI();
onResize();

//==================================================================
// 自己テスト（コンソールで runSelfTest() ）
//==================================================================
window.runSelfTest=function(){
  const near=(a,b,t=0.01,msg='')=>{ if(Math.abs(a-b)>t) throw new Error(`FAIL ${msg}: ${a} vs ${b}`); console.log('ok',msg,a.toFixed(3)); };
  const compute=state.preset.compute;
  // 水平S1終板, 鉛直骨盤線 → SS=0, PT=0, PI=0, LL=0
  let r=compute({femL:{x:0,y:200},femR:{x:100,y:200},
    s1a:{x:0,y:100},s1p:{x:100,y:100},l1a:{x:0,y:0},l1p:{x:100,y:0}});
  near(r.SS,0,0.01,'SS horizontal'); near(r.PT,0,0.01,'PT vertical');
  near(r.PI,0,0.01,'PI'); near(r.LL,0,0.01,'LL parallel');
  // 45°傾いたS1 → SS=45
  r=compute({femL:{x:0,y:200},femR:{x:100,y:200},
    s1a:{x:0,y:0},s1p:{x:100,y:100},l1a:{x:0,y:0},l1p:{x:100,y:0}});
  near(r.SS,45,0.01,'SS 45deg'); near(r.LL,45,0.01,'LL 45 vs 0');
  // SVA: 前方は画面左(x=0側)。C7中点 x=120 は S1後縁 x=100 より後方 → -20px
  r=compute({femL:{x:0,y:300},femR:{x:100,y:300},
    s1a:{x:0,y:200},s1p:{x:100,y:200},l1a:{x:0,y:100},l1p:{x:100,y:100},
    c7a:{x:110,y:0},c7p:{x:130,y:0}}, 2);
  near(r.svaPx,-20,0.01,'SVA px'); near(r.svaMm,-10,0.01,'SVA mm');
  // PT符号テスト: anterior=LEFT(antSign=-1)、FHがS1より後方(x大) → PT>0 (正常解剖)
  r=compute({femL:{x:75,y:300},femR:{x:95,y:300},
    s1a:{x:30,y:200},s1p:{x:90,y:215},l1a:{x:35,y:110},l1p:{x:85,y:100}});
  if(r.PT<=0) throw new Error('FAIL PT sign: expected >0, got '+r.PT);
  console.log('ok PT positive (FH posterior)',r.PT.toFixed(3));
  // 左右反転不変性: x座標を反転しても全計測値が一致する（符号付き化の要点）
  const cfg={femL:{x:20,y:300},femR:{x:80,y:300},
    s1a:{x:30,y:200},s1p:{x:90,y:215},l1a:{x:35,y:110},l1p:{x:85,y:100},
    c7a:{x:60,y:10},c7p:{x:75,y:14}};
  const mir=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,{x:-v.x,y:v.y}]));
  const a=compute(cfg,2), b=compute(mir(cfg),2);
  for(const k of ['PI','PT','SS','LL','svaPx','svaMm']) near(a[k],b[k],1e-6,'mirror '+k);
  console.log('%c runSelfTest: ALL PASSED','color:green;font-weight:bold');
  return true;
};
