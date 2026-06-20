// Thin resident in-frame runtimes for streaming renderers (#581 PV-stream / PV-gltf).
// Each runtime is a self-contained HTML string baked into a persistent iframe.
// The host sends commands via postMessage; the runtime signals back via parent.postMessage.
//
// Delivery contract:
//   host → frame: { __preview_cmd: 'render_bundle', bundleJs: string, importmap?: Record<string,string> }
//                 { __preview_cmd: 'render_gltf',   url?: string, base64?: string }
//   frame → host: { __preview: 'ready' | 'error' | 'runtime_ready', message?: string }

import { DEFAULT_IMPORTMAP } from '../previewBundle';

/**
 * Builds the srcdoc for the streaming html/react-bundle iframe. The thin runtime:
 * - Signals `{ __preview: 'runtime_ready' }` once loaded.
 * - On `render_bundle`: clears #root, creates a blob URL from bundleJs, dynamically
 *   imports it (React + esm.sh externals resolved via import-map), then signals ready.
 * - Falls back to `render_srcdoc` for a full document replace (legacy support).
 */
export function buildStreamingFrameHtml(importmap: Record<string, string> = DEFAULT_IMPORTMAP): string {
  const im = JSON.stringify({ imports: importmap });
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>html,body,#root{margin:0;height:100%;background:var(--bg,#0d0d0f);font-family:Inter,system-ui,sans-serif;color:#eee}</style>
<script type="importmap">${im}</script>
</head><body><div id="root"></div>
<script>
var _bscRoot=null;
window.addEventListener('message',async function(e){
  var d=e.data;
  if(!d)return;
  if(d.__preview_cmd==='render_bundle'){
    try{
      if(_bscRoot){try{_bscRoot.unmount();}catch(_){}_bscRoot=null;}
      document.getElementById('root').innerHTML='';
      var blob=new Blob([d.bundleJs],{type:'text/javascript'});
      var url=URL.createObjectURL(blob);
      await import(url);
      URL.revokeObjectURL(url);
      parent.postMessage({__preview:'ready'},'*');
    }catch(err){
      parent.postMessage({__preview:'error',message:String(err)},'*');
    }
  }
  // Legacy full-document replace — for srcDoc payloads without extracted bundleJs.
  if(d.__preview_cmd==='render_srcdoc'){
    try{document.open();document.write(d.html);document.close();}catch(err){
      parent.postMessage({__preview:'error',message:String(err)},'*');
    }
  }
});
parent.postMessage({__preview:'runtime_ready'},'*');
</script></body></html>`;
}

/**
 * Builds the srcdoc for the streaming glTF iframe. The thin runtime:
 * - Loads three.js + GLTFLoader from esm.sh and sets up a scene with orbit controls.
 * - On `render_gltf`: loads the model from a URL or base64 data URI, auto-fits the
 *   camera, and auto-rotates. Replaces the previous model on each call.
 */
export function buildGltfRuntimeHtml(): string {
  const threeUrl = DEFAULT_IMPORTMAP['three'] ?? 'https://esm.sh/three@0.169.0';
  const loaderUrl = `${threeUrl.replace(/\?.*$/, '')}/examples/jsm/loaders/GLTFLoader.js`;
  const controlsUrl = `${threeUrl.replace(/\?.*$/, '')}/examples/jsm/controls/OrbitControls.js`;
  const im = JSON.stringify({ imports: { three: threeUrl } });
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>html,body,canvas{margin:0;width:100%;height:100%;display:block;background:#0d0d0f;overflow:hidden}</style>
<script type="importmap">${im}</script>
</head><body>
<canvas id="c"></canvas>
<script type="module">
import*as THREE from 'three';
import{GLTFLoader}from'${loaderUrl}';
import{OrbitControls}from'${controlsUrl}';

const canvas=document.getElementById('c');
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth,innerHeight);
renderer.outputColorSpace=THREE.SRGBColorSpace;

const scene=new THREE.Scene();
scene.background=new THREE.Color(0x0d0d0f);
const camera=new THREE.PerspectiveCamera(45,innerWidth/innerHeight,0.001,1000);
camera.position.set(0,1.5,3);

const ambient=new THREE.AmbientLight(0xffffff,0.8);
const dir=new THREE.DirectionalLight(0xffffff,1.2);
dir.position.set(2,4,3);
scene.add(ambient,dir);

const controls=new OrbitControls(camera,renderer.domElement);
controls.enableDamping=true;
controls.dampingFactor=0.05;

let model=null;
const loader=new GLTFLoader();

window.addEventListener('message',function(e){
  const d=e.data;
  if(d?.__preview_cmd!=='render_gltf')return;
  const url=d.url||('data:model/gltf+json;base64,'+d.base64);
  loader.load(url,function(gltf){
    if(model)scene.remove(model);
    model=gltf.scene;
    scene.add(model);
    const box=new THREE.Box3().setFromObject(model);
    const size=box.getSize(new THREE.Vector3()).length();
    const center=box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    camera.near=size/100;camera.far=size*100;
    camera.position.set(0,size*0.4,size*1.2);
    camera.updateProjectionMatrix();
    controls.update();
    parent.postMessage({__preview:'ready'},'*');
  },undefined,function(err){
    parent.postMessage({__preview:'error',message:String(err)},'*');
  });
});

window.addEventListener('resize',function(){
  renderer.setSize(innerWidth,innerHeight);
  camera.aspect=innerWidth/innerHeight;
  camera.updateProjectionMatrix();
});

(function animate(){requestAnimationFrame(animate);controls.update();renderer.render(scene,camera);})();
parent.postMessage({__preview:'runtime_ready'},'*');
</script></body></html>`;
}
