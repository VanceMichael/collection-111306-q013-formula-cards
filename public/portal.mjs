let state=await(await fetch('/api/snapshot')).json();
document.querySelector('#conflict').onclick=()=>{document.querySelector('annotation').textContent='x/t';};
document.querySelector('#replace').onclick=()=>{setTimeout(()=>{const fraction=document.querySelector('mfrac');fraction.innerHTML='<mi>q</mi><msup><mi>t</mi><mn>2</mn></msup>';},80);};
window.portalReady=true;
