import dicomParser from 'dicom-parser';

// 単純X線（CR/DX）DICOMを表示用の8bitグレースケールcanvasへ変換する。
// 対応は非圧縮（Implicit/Explicit VR Little Endian）のみ。院内の単純X線はほぼこれで、
// JPEG系の圧縮DICOMまで扱うにはデコーダー（WASM）が必要になり単一HTMLが肥大化するため見送る。
const UNCOMPRESSED = new Set([
  '1.2.840.10008.1.2',     // Implicit VR Little Endian
  '1.2.840.10008.1.2.1',   // Explicit VR Little Endian
]);

// DICOM Part10は先頭128バイトのプリアンブル直後に "DICM" が来る。拡張子なし（FILE1等）の
// ファイルも多いため、拡張子ではなく中身で判定する。
// DICOMDIR（フォルダの索引ファイル）も "DICM" を持つが画像ではないので除外する。
export async function isDicom(file){
  if(file.size<132 || /^DICOMDIR$/i.test(file.name)) return false;
  try{
    const b=new Uint8Array(await file.slice(128,132).arrayBuffer());
    return b[0]===0x44 && b[1]===0x49 && b[2]===0x43 && b[3]===0x4d;
  }catch{ return false; }   // ドロップされたフォルダ等、読めないものは対象外
}

// file -> { canvas, aiCanvas, pxPerMm }（pxPerMm はピクセル間隔タグが無い/縦横で異なる場合 null）
export async function decodeDicom(file){
  const bytes=new Uint8Array(await file.arrayBuffer());
  const ds=dicomParser.parseDicom(bytes);
  const ts=ds.string('x00020010');
  if(ts && !UNCOMPRESSED.has(ts)) throw new Error(`圧縮DICOM（${ts}）には未対応です`);

  const rows=ds.uint16('x00280010'), cols=ds.uint16('x00280011');
  const bitsAlloc=ds.uint16('x00280100'), signed=ds.uint16('x00280103')===1;
  const spp=ds.uint16('x00280002')||1;
  const photo=(ds.string('x00280004')||'MONOCHROME2').trim();
  const px=ds.elements.x7fe00010;
  if(!px || !rows || !cols) throw new Error('画素データが見つかりません');
  if(spp!==1 || !photo.startsWith('MONOCHROME')) throw new Error(`グレースケール以外（${photo}）には未対応です`);
  if(bitsAlloc!==8 && bitsAlloc!==16) throw new Error(`BitsAllocated=${bitsAlloc} には未対応です`);

  // 画素データのオフセットは奇数のこともあり型付き配列を直接被せられないため、DataViewで読む
  const n=rows*cols;
  const view=new DataView(bytes.buffer, bytes.byteOffset+px.dataOffset, Math.min(px.length, n*bitsAlloc/8));
  const slope=ds.floatString('x00281053') ?? 1, icpt=ds.floatString('x00281052') ?? 0;
  const raw=new Float32Array(n);
  for(let i=0;i<n;i++){
    const v = bitsAlloc===8 ? (signed?view.getInt8(i):view.getUint8(i))
                            : (signed?view.getInt16(i*2,true):view.getUint16(i*2,true));
    raw[i]=v*slope+icpt;
  }

  // ウィンドウはタグ値でなく1-99パーセンタイルで自動設定する。施設によっては
  // WindowCenter/Widthが全階調そのまま（眠い画像）で入っており、AIの前処理とも揃えられるため。
  const sorted=raw.slice().sort();
  const lo=sorted[Math.floor((n-1)*0.01)], hi=sorted[Math.floor((n-1)*0.99)];
  const span=Math.max(hi-lo, 1e-6);
  const invert = photo==='MONOCHROME1';   // MONOCHROME1は高値=黒なので反転して骨を白にする

  const toCanvas=(lo, span)=>{
    const canvas=document.createElement('canvas'); canvas.width=cols; canvas.height=rows;
    const ctx=canvas.getContext('2d');
    const img=ctx.createImageData(cols, rows), d=img.data;
    for(let i=0,p=0;i<n;i++,p+=4){
      let g=(Math.min(Math.max(raw[i],lo),lo+span)-lo)/span*255;
      if(invert) g=255-g;
      d[p]=d[p+1]=d[p+2]=g; d[p+3]=255;
    }
    ctx.putImageData(img,0,0);
    return canvas;
  };
  const canvas=toCanvas(lo, span);
  // AI入力用は全階調をそのまま8bitに収める。表示用は1-99%でクリップしているため、骨盤など
  // 濃い領域が飽和して潰れ、AI側で枠ごとに正規化し直してもコントラストが戻らない
  // （全脊椎モデルで大腿骨頭が検出できなくなる）。
  const aiCanvas=toCanvas(sorted[0], Math.max(sorted[n-1]-sorted[0], 1e-6));

  // PixelSpacing（無ければ検出器面のImagerPixelSpacing）。値は "行間隔\列間隔" [mm]
  const sp=(ds.string('x00280030')||ds.string('x00181164')||'').split('\\').map(parseFloat);
  const pxPerMm = sp.length===2 && sp[0]>0 && Math.abs(sp[0]-sp[1])<1e-6 ? 1/sp[0] : null;
  return { canvas, aiCanvas, pxPerMm };
}
