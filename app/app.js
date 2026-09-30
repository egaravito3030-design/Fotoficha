/* FotoFicha — web app (PWA) para iPhone.
   Cámara con ficha: fecha automática, ubicación (auto / pendiente / manual),
   personas, información extra y "Ubicación exacta" (Google Maps + coordenadas opcionales).
   Todo se guarda solo en el teléfono (IndexedDB). */
'use strict';

const VERSION = '1.0.0';
const $ = (id) => document.getElementById(id);

/* ======================= utilidades ======================= */
const pad = (n) => String(n).padStart(2, '0');
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function fmtFecha(d) { return `${DIAS[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; }
function fmtFechaCorta(d) { return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; }
function fmtHora(d, seg = true) {
  let h = d.getHours(); const ap = h < 12 ? 'a. m.' : 'p. m.'; h = h % 12 || 12;
  return `${h}:${pad(d.getMinutes())}${seg ? ':' + pad(d.getSeconds()) : ''} ${ap}`;
}
function toLocalInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtAlt(a) { return (a === null || a === undefined || isNaN(a)) ? null : `${Math.round(a).toLocaleString('es-CO')} m s. n. m.`; }
function lugarTexto(o) { return [o.ciudad, o.depto, o.pais].filter(Boolean).join(', '); }
function uid() { return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
function lsGet(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } }
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
let toastT;
function toast(msg, ms = 2200) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}
function modal(html, botones) {
  return new Promise((res) => {
    $('modalTxt').innerHTML = html;
    const cont = $('modalBtns'); cont.innerHTML = '';
    botones.forEach((b) => {
      const el = document.createElement('button');
      el.className = 'btn' + (b.pri ? ' pri' : ''); el.textContent = b.txt;
      el.onclick = () => { $('modal').classList.add('hidden'); res(b.val); };
      cont.appendChild(el);
    });
    $('modal').classList.remove('hidden');
  });
}

/* ======================= base de datos (IndexedDB) ======================= */
let db;
function abrirDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('fotoficha', 1);
    r.onupgradeneeded = () => {
      const s = r.result.createObjectStore('fotos', { keyPath: 'id', autoIncrement: true });
      s.createIndex('uid', 'uid', { unique: true });
    };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
function tx(modo, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction('fotos', modo); const s = t.objectStore('fotos');
    let out; const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const dbPut = (o) => tx('readwrite', (s) => s.put(o));
const dbDel = (id) => tx('readwrite', (s) => s.delete(id));
const dbGet = (id) => tx('readonly', (s) => s.get(id));
const dbAll = () => tx('readonly', (s) => s.getAll());

/* ======================= estado ======================= */
const geo = { estado: 'buscando', fix: null, watchId: null, err: null }; // fix: {lat,lon,acc,alt,ts}
let lugarAuto = { pais: '', depto: '', ciudad: '', desde: null, cargando: false }; // de la geocodificación
let form;           // datos de la próxima foto (o de la ficha en edición)
let modoDatos = 'nueva'; // 'nueva' | 'editar'
let fichaActual = null;  // registro abierto en la ficha
let facing = 'environment';
let stream = null;

function formNuevo() {
  const prev = lsGet('ultimoForm', null);
  return {
    fechaManual: null,
    ubicManual: false, pais: '', depto: '', ciudad: '',
    coords: null,
    personas: prev && prev.personas && prev.personas.length ? prev.personas.slice() : [''],
    extras: prev && prev.extras && prev.extras.length ? prev.extras.map((e) => ({ ...e })) : [{ k: '', v: '' }],
  };
}

/* ======================= geolocalización ======================= */
function iniciarGeo() {
  if (!('geolocation' in navigator)) { geo.estado = 'apagada'; pintarTodo(); return; }
  if (geo.watchId !== null) navigator.geolocation.clearWatch(geo.watchId);
  geo.estado = geo.fix ? geo.estado : 'buscando';
  geo.watchId = navigator.geolocation.watchPosition(onGeo, onGeoErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
function onGeo(p) {
  const nuevo = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude, ts: p.timestamp };
  const antes = geo.estado;
  geo.fix = nuevo; geo.estado = 'activa'; geo.err = null;
  if (!lugarAuto.desde || distM(lugarAuto.desde, nuevo) > 300) geocodificar(nuevo);
  if (antes !== 'activa') revisarPendientes();
  pintarTodo();
}
function onGeoErr(e) {
  geo.err = e;
  if (e.code === 1 || e.code === 2) { geo.estado = 'apagada'; geo.fix = null; }
  else if (!geo.fix) geo.estado = 'buscando';
  pintarTodo();
}
function activarUbicacion() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition((p) => { onGeo(p); iniciarGeo(); }, (e) => {
    onGeoErr(e);
    if (e.code === 1) {
      modal(`<b>La ubicación está bloqueada</b><p>El iPhone no deja que la app la use. Para activarla:</p>
        <ol><li>Ajustes → Privacidad y seguridad → Localización → <b>activado</b>.</li>
        <li>En esa misma lista: Safari (o "Sitios web de Safari") → <b>Al usar la app</b>.</li>
        <li>Vuelve a FotoFicha y toca "Activar ubicación".</li></ol>
        <p class="nota">Mientras tanto puedes poner la ubicación a mano.</p>`, [{ txt: 'Entendido', pri: true }]);
    } else if (e.code === 2) {
      toast('El GPS no responde. Revisa que la Localización esté activada.');
    }
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}

/* Geocodificación inversa (coordenadas -> país/departamento/ciudad). Necesita internet. */
const geoCache = lsGet('geoCache', {});
async function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (geoCache[key]) return geoCache[key];
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1&accept-language=es`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('geocode ' + r.status);
  const j = await r.json(); const a = j.address || {};
  const out = {
    pais: a.country || '',
    depto: a.state || a.region || a.state_district || '',
    ciudad: a.city || a.town || a.village || a.municipality || a.hamlet || a.county || '',
  };
  geoCache[key] = out;
  const ks = Object.keys(geoCache); if (ks.length > 200) delete geoCache[ks[0]];
  lsSet('geoCache', geoCache);
  return out;
}
async function geocodificar(fix) {
  if (lugarAuto.cargando) return;
  lugarAuto.cargando = true; pintarTodo();
  try {
    const o = await reverseGeocode(fix.lat, fix.lon);
    lugarAuto = { ...o, desde: { lat: fix.lat, lon: fix.lon }, cargando: false };
  } catch (e) {
    lugarAuto.cargando = false; lugarAuto.sinRed = true;
  }
  pintarTodo();
}

/* Fotos con ciudad pendiente por falta de internet (tienen coordenadas internas): se completan solas. */
async function completarCiudadesSinRed() {
  if (!navigator.onLine) return;
  const todas = await dbAll();
  for (const f of todas) {
    if (f.geoInt && !f.ubicManual && !f.ciudad && !f.pais) {
      try {
        const o = await reverseGeocode(f.geoInt.lat, f.geoInt.lon);
        Object.assign(f, o); await dbPut(f);
        await new Promise((r) => setTimeout(r, 1100)); // respeta el límite del servicio gratuito
      } catch (e) { break; }
    }
  }
}

/* Fotos tomadas SIN ubicación: se pregunta antes de completarlas (uno pudo haberse movido). */
async function revisarPendientes() {
  const n = (await dbAll()).filter((f) => f.ubicPendiente).length;
  const chip = $('chipPend');
  if (n > 0 && geo.estado === 'activa') {
    chip.textContent = `${n} foto${n > 1 ? 's' : ''} con ubicación pendiente ›`;
    chip.classList.remove('hidden');
  } else chip.classList.add('hidden');
  const b = $('bannerPendGal');
  if (n > 0) {
    b.innerHTML = `<b>${n} foto${n > 1 ? 's' : ''} con ubicación pendiente</b>Ábrelas (marca naranja) para completarlas con la ubicación actual o a mano.`;
    b.classList.remove('hidden');
  } else b.classList.add('hidden');
}

/* ======================= Google Maps ======================= */
function abrirGoogleMaps(lat, lon) {
  const app = `comgooglemaps://?q=${lat},${lon}&center=${lat},${lon}&zoom=17`;
  const web = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  let salio = false;
  const onHide = () => { if (document.visibilityState === 'hidden') salio = true; };
  document.addEventListener('visibilitychange', onHide);
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide);
    if (!salio && document.visibilityState === 'visible') window.location.href = web; // Google Maps no instalada
  }, 1600);
  window.location.href = app;
}

/* ======================= cámara ======================= */
async function iniciarCamara() {
  $('camMsg').classList.add('hidden');
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return errorCamara('Este navegador no permite usar la cámara en vivo.');
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false,
    });
    const v = $('video'); v.srcObject = stream; await v.play().catch(() => {});
  } catch (e) {
    errorCamara(e && e.name === 'NotAllowedError'
      ? 'No hay permiso para la cámara. Ajustes → Safari → Cámara → Permitir, y luego Reintentar.'
      : 'No se pudo abrir la cámara (' + (e && e.name || 'error') + ').');
  }
}
function errorCamara(txt) { $('camMsgTxt').textContent = txt; $('camMsg').classList.remove('hidden'); }

function capturarDeVideo() {
  const v = $('video');
  if (!stream || !v.videoWidth) return null;
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  return c.toDataURL('image/jpeg', 0.92);
}
function archivoADataURL(file) {
  // re-dibuja en canvas: corrige orientación y deja un JPEG limpio para escribirle la ficha
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0); URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = rej; img.src = url;
  });
}
function miniatura(dataURL) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const m = 360, k = Math.min(1, m / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => res(''); img.src = dataURL;
  });
}
function dataURLaBlob(d) {
  const [h, b] = d.split(','); const bin = atob(b); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: h.match(/:(.*?);/)[1] });
}
function blobADataURL(bl) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(bl); });
}

/* ======================= EXIF (la ficha viaja dentro de la foto) ======================= */
function asciiFold(s) { return String(s).replace(/±/g, '+/-').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?'); }
function userCommentUnicode(s) {
  let out = 'UNICODE\0'; // piexif escribe en big-endian
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out += String.fromCharCode(c >> 8, c & 255); }
  return out;
}
function gradosRac(x) {
  x = Math.abs(x); const d = Math.floor(x); const mF = (x - d) * 60; const m = Math.floor(mF);
  const s = Math.round((mF - m) * 60 * 10000);
  return [[d, 1], [m, 1], [s, 10000]];
}
function textoFicha(r) {
  const partes = [];
  partes.push('Fecha: ' + fmtFechaCorta(new Date(r.fecha)) + ' ' + fmtHora(new Date(r.fecha)));
  const lug = lugarTexto(r); if (lug) partes.push('Lugar: ' + lug);
  if (fmtAlt(r.altitud)) partes.push('Altitud: ' + fmtAlt(r.altitud));
  const ps = (r.personas || []).filter(Boolean); if (ps.length) partes.push('Personas: ' + ps.join(', '));
  (r.extras || []).filter((e) => e.k || e.v).forEach((e) => partes.push(`${e.k}: ${e.v}`));
  if (r.coords) partes.push(`GPS: ${r.coords.lat.toFixed(6)}, ${r.coords.lon.toFixed(6)} (±${Math.round(r.coords.acc)} m)`);
  return partes.join(' | ');
}
function escribirExif(dataURL, r) {
  if (!window.piexif) return dataURL;
  try {
    const d = new Date(r.fecha);
    const exifFecha = `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const off = -d.getTimezoneOffset(); const offTxt = `${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
    const txt = textoFicha(r);
    const zeroth = {}; const exif = {}; const gps = {};
    zeroth[piexif.ImageIFD.ImageDescription] = asciiFold(txt);
    zeroth[piexif.ImageIFD.Software] = 'FotoFicha ' + VERSION;
    zeroth[piexif.ImageIFD.DateTime] = exifFecha;
    exif[piexif.ExifIFD.DateTimeOriginal] = exifFecha;
    exif[piexif.ExifIFD.DateTimeDigitized] = exifFecha;
    if (piexif.ExifIFD.OffsetTimeOriginal) exif[piexif.ExifIFD.OffsetTimeOriginal] = offTxt;
    exif[piexif.ExifIFD.UserComment] = userCommentUnicode(txt);
    if (r.coords) { // solo si se tocó "Ubicación exacta"
      gps[piexif.GPSIFD.GPSLatitudeRef] = r.coords.lat >= 0 ? 'N' : 'S';
      gps[piexif.GPSIFD.GPSLatitude] = gradosRac(r.coords.lat);
      gps[piexif.GPSIFD.GPSLongitudeRef] = r.coords.lon >= 0 ? 'E' : 'W';
      gps[piexif.GPSIFD.GPSLongitude] = gradosRac(r.coords.lon);
      if (typeof r.altitud === 'number' && !isNaN(r.altitud)) {
        gps[piexif.GPSIFD.GPSAltitudeRef] = r.altitud < 0 ? 1 : 0;
        gps[piexif.GPSIFD.GPSAltitude] = [Math.round(Math.abs(r.altitud) * 100), 100];
      }
    }
    const bytes = piexif.dump({ '0th': zeroth, 'Exif': exif, 'GPS': gps });
    return piexif.insert(bytes, dataURL);
  } catch (e) { console.warn('EXIF', e); return dataURL; }
}

/* ======================= día del cultivo ======================= */
function lotes() { return lsGet('lotes', []); }
function diaCultivo(extras, fechaISO) {
  const lote = (extras || []).find((e) => norm(e.k) === 'lote');
  if (!lote || !lote.v) return null;
  const l = lotes().find((x) => norm(x.nombre) === norm(lote.v) && x.siembra);
  if (!l) return null;
  const [y, m, d] = l.siembra.split('-').map(Number);
  const f = new Date(fechaISO); const a = Date.UTC(y, m - 1, d); const b = Date.UTC(f.getFullYear(), f.getMonth(), f.getDate());
  return Math.round((b - a) / 86400000);
}

/* ======================= datos del formulario → registro ======================= */
function fechaDelForm() { return form.fechaManual ? new Date(form.fechaManual) : new Date(); }
function lugarDelForm() {
  if (form.ubicManual) return { pais: form.pais, depto: form.depto, ciudad: form.ciudad };
  if (modoDatos === 'editar') return { pais: form.pais, depto: form.depto, ciudad: form.ciudad };
  if (geo.estado === 'activa') return { pais: lugarAuto.pais, depto: lugarAuto.depto, ciudad: lugarAuto.ciudad };
  return { pais: '', depto: '', ciudad: '' };
}
function altDelForm() {
  if (modoDatos === 'editar') return form.altitud ?? null;
  return geo.estado === 'activa' && geo.fix && geo.fix.alt !== null ? geo.fix.alt : null;
}
function limpiarListas() {
  return {
    personas: form.personas.map((p) => p.trim()).filter(Boolean),
    extras: form.extras.map((e) => ({ k: e.k.trim(), v: e.v.trim() })).filter((e) => e.k || e.v),
  };
}
function recordarNombresYClaves(personas, extras) {
  const n = new Set(lsGet('nombres', [])); personas.forEach((p) => n.add(p)); lsSet('nombres', [...n].slice(-300));
  const k = new Set(lsGet('claves', [])); extras.forEach((e) => e.k && k.add(e.k)); lsSet('claves', [...k].slice(-100));
  pintarDatalists();
}

async function tomarFoto(dataURLExterno) {
  const dataURL = dataURLExterno || capturarDeVideo();
  if (!dataURL) { toast('La cámara todavía no está lista.'); return; }
  $('flash').classList.remove('hidden'); setTimeout(() => $('flash').classList.add('hidden'), 120);
  const fecha = fechaDelForm();
  const lug = lugarDelForm();
  const { personas, extras } = limpiarListas();
  const dia = diaCultivo(extras, fecha.toISOString());
  const extrasFinal = extras.filter((e) => norm(e.k) !== 'dia del cultivo');
  if (dia !== null) extrasFinal.push({ k: 'Día del cultivo', v: String(dia), calc: true });
  const conGeo = geo.estado === 'activa' && geo.fix;
  const r = {
    uid: uid(), fecha: fecha.toISOString(),
    ...lug, altitud: altDelForm(), ubicManual: form.ubicManual,
    geoInt: conGeo ? { lat: geo.fix.lat, lon: geo.fix.lon, acc: geo.fix.acc } : null,
    ubicPendiente: !conGeo && !(form.ubicManual && (lug.pais || lug.depto || lug.ciudad)),
    coords: form.coords ? { ...form.coords } : null,
    personas, extras: extrasFinal,
  };
  const conExif = escribirExif(dataURL, r);
  r.blob = dataURLaBlob(conExif);
  r.thumb = await miniatura(conExif);
  try { r.id = await dbPut(r); } catch (e) { toast('No se pudo guardar: ' + e.message, 4000); return; }
  encolarAnalisis(r.id);
  recordarNombresYClaves(personas, extras);
  lsSet('ultimoForm', { personas: form.personas, extras: form.extras.filter((e) => norm(e.k) !== 'dia del cultivo') });
  // para la siguiente foto: fecha vuelve a automática y las coordenadas se piden de nuevo
  form.fechaManual = null; form.coords = null;
  toast(r.ubicPendiente ? 'Guardada · ubicación pendiente' : 'Foto guardada');
  pintarTodo(); pintarUltima(); revisarPendientes();
}

/* ======================= pintar: cámara ======================= */
let tagAbierta = false;
function pintarCamara() {
  const chip = $('chipUbic'); const dot = chip.querySelector('.dot'); const sp = chip.querySelector('span');
  dot.className = 'dot' + (geo.estado === 'activa' ? ' ok' : geo.estado === 'apagada' ? ' warn' : '');
  sp.textContent = geo.estado === 'activa' ? 'Ubicación activa' : geo.estado === 'apagada' ? 'Ubicación apagada · activar' : 'Buscando ubicación…';

  const lug = lugarDelForm(); const { personas, extras } = limpiarListas();
  const lugTxt = lug.ciudad || lug.depto || lug.pais || (geo.estado === 'activa' ? (lugarAuto.cargando ? 'Ubicando…' : 'Sin nombre de lugar') : 'Sin ubicación');
  $('tagCerrada').innerHTML = `🏷 ${esc(lugTxt)} · ${personas.length} persona${personas.length === 1 ? '' : 's'} · ${extras.length} extra <span class="ar">▴</span>`;

  const f = fechaDelForm(); const dia = diaCultivo(extras, f.toISOString());
  const ext = extras.filter((e) => norm(e.k) !== 'dia del cultivo').map((e) => `${e.k}${e.k && e.v ? ': ' : ''}${e.v}`);
  if (dia !== null) ext.unshift(`Día del cultivo: ${dia}`);
  const filas = [
    ['Fecha', `${fmtFechaCorta(f)} · ${fmtHora(f, false)}`],
    ['Ubicación', lugarTexto(lug) || (geo.estado === 'apagada' ? 'pendiente' : '—')],
    ['Altitud', fmtAlt(altDelForm()) || '—'],
    ['Personas', personas.join(', ') || '—'],
    ['Extra', ext.join(' · ') || '—'],
  ];
  $('miniRows').innerHTML = filas.map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('');
  $('tagCerrada').classList.toggle('hidden', tagAbierta);
  $('tagAbierta').classList.toggle('hidden', !tagAbierta);
}
async function pintarUltima() {
  const todas = await dbAll(); const u = todas[todas.length - 1];
  $('btnGaleria').style.backgroundImage = u && u.thumb ? `url(${u.thumb})` : 'none';
}

/* ======================= pintar: hoja de datos ======================= */
function pintarDatos() {
  const editar = modoDatos === 'editar';
  $('datosTitulo').textContent = editar ? 'Editar ficha' : 'Datos de la foto';
  $('btnGuardarDatos').textContent = editar ? 'Guardar cambios' : 'Guardar y tomar foto';

  const f = fechaDelForm();
  $('vFecha').textContent = fmtFecha(f); $('vHora').textContent = fmtHora(f);
  $('badgeFecha').textContent = form.fechaManual ? 'manual' : 'automático';
  $('badgeFecha').className = 'auto' + (form.fechaManual ? ' m' : '');
  if (document.activeElement !== $('inpFecha')) $('inpFecha').value = toLocalInput(f);
  $('btnFechaAuto').classList.toggle('hidden', !form.fechaManual || editar);

  const apagada = !editar && geo.estado !== 'activa' && !form.ubicManual;
  $('bannerUbic').classList.toggle('hidden', !(apagada && geo.estado === 'apagada'));
  const bu = $('badgeUbic');
  if (form.ubicManual) { bu.textContent = 'manual'; bu.className = 'auto m'; }
  else if (editar) { bu.textContent = fichaActual && fichaActual.ubicPendiente ? 'pendiente' : 'guardada'; bu.className = 'auto' + (fichaActual && fichaActual.ubicPendiente ? ' p' : ''); }
  else if (geo.estado === 'activa') { bu.textContent = lugarAuto.cargando ? 'buscando nombre…' : (lugarAuto.sinRed && !lugarAuto.ciudad ? 'sin internet: se llena después' : 'automático'); bu.className = 'auto'; }
  else { bu.textContent = geo.estado === 'buscando' ? 'buscando…' : 'pendiente'; bu.className = 'auto p'; }

  $('ubicVista').classList.toggle('hidden', form.ubicManual);
  $('ubicManual').classList.toggle('hidden', !form.ubicManual);
  $('btnEditarUbic').textContent = form.ubicManual ? (editar ? 'Listo' : 'Volver a automático') : 'Editar manual';
  const lug = lugarDelForm(); const ph = '<span class="ph">se llena al activar</span>';
  const val = (x) => x ? esc(x) : (apagada ? ph : (lugarAuto.cargando ? '<span class="ph">…</span>' : '<span class="ph">—</span>'));
  $('vPais').innerHTML = val(lug.pais); $('vDepto').innerHTML = val(lug.depto); $('vCiudad').innerHTML = val(lug.ciudad);
  $('vAlt').innerHTML = fmtAlt(altDelForm()) ? esc(fmtAlt(altDelForm())) : (apagada ? ph : '<span class="ph">no disponible</span>');
  $('notaPendiente').classList.toggle('hidden', !apagada);

  const puedeExacta = editar ? !!(fichaActual && fichaActual.geoInt) : geo.estado === 'activa';
  $('btnUbicExacta').classList.toggle('hidden', !puedeExacta);
  $('secCoords').classList.toggle('hidden', !form.coords);
  if (form.coords) {
    $('vLat').textContent = form.coords.lat.toFixed(6); $('vLon').textContent = form.coords.lon.toFixed(6);
    $('vAcc').textContent = `± ${Math.round(form.coords.acc)} m`;
  }

  const { extras } = limpiarListas(); const dia = diaCultivo(extras, f.toISOString());
  $('rowDiaCultivo').classList.toggle('hidden', dia === null);
  if (dia !== null) $('vDiaCultivo').textContent = dia;
}
function pintarPersonas() {
  const cont = $('listaPersonas'); cont.innerHTML = '';
  form.personas.forEach((p, i) => {
    const row = document.createElement('div'); row.className = 'inp';
    row.innerHTML = `<span class="num">${i + 1}</span><input list="dlNombres" placeholder="Nombre…" autocomplete="off" autocapitalize="words"><button class="x" aria-label="Quitar">✕</button>`;
    const inp = row.querySelector('input'); inp.value = p;
    inp.oninput = () => { form.personas[i] = inp.value; pintarSugerencias(); pintarCamara(); };
    row.querySelector('.x').onclick = () => { form.personas.splice(i, 1); if (!form.personas.length) form.personas.push(''); pintarPersonas(); pintarCamara(); };
    cont.appendChild(row);
  });
  pintarSugerencias();
}
function pintarSugerencias() {
  const usados = new Set(form.personas.map(norm));
  const s = lsGet('nombres', []).filter((n) => !usados.has(norm(n))).slice(-8).reverse();
  const cont = $('sugPersonas'); cont.innerHTML = '';
  s.forEach((n) => {
    const b = document.createElement('button'); b.textContent = n;
    b.onclick = () => {
      const vacia = form.personas.findIndex((p) => !p.trim());
      if (vacia >= 0) form.personas[vacia] = n; else form.personas.push(n);
      pintarPersonas(); pintarCamara();
    };
    cont.appendChild(b);
  });
}
function pintarExtras() {
  const cont = $('listaExtras'); cont.innerHTML = '';
  form.extras.forEach((e, i) => {
    if (e.calc) return;
    const row = document.createElement('div'); row.className = 'kv';
    row.innerHTML = `<input list="dlClaves" placeholder="Campo (ej. Lote)" autocomplete="off"><input placeholder="Valor" autocomplete="off"><button class="x" aria-label="Quitar">✕</button>`;
    const [ik, iv] = row.querySelectorAll('input'); ik.value = e.k; iv.value = e.v;
    ik.oninput = () => { form.extras[i].k = ik.value; pintarDatos(); pintarCamara(); };
    iv.oninput = () => { form.extras[i].v = iv.value; pintarDatos(); pintarCamara(); };
    row.querySelector('.x').onclick = () => { form.extras.splice(i, 1); if (!form.extras.filter((x) => !x.calc).length) form.extras.push({ k: '', v: '' }); pintarExtras(); pintarDatos(); pintarCamara(); };
    cont.appendChild(row);
  });
}
function pintarLotes() {
  const cont = $('listaLotes'); cont.innerHTML = ''; const ls = lotes();
  ls.forEach((l, i) => {
    const row = document.createElement('div'); row.className = 'lote';
    row.innerHTML = `<input placeholder="Lote (ej. 3)" autocomplete="off"><input type="date"><button class="x" aria-label="Quitar">✕</button>`;
    const [a, b] = row.querySelectorAll('input'); a.value = l.nombre; b.value = l.siembra || '';
    const guardar = () => { const x = lotes(); x[i] = { nombre: a.value, siembra: b.value }; lsSet('lotes', x); pintarDatos(); pintarCamara(); };
    a.oninput = guardar; b.onchange = guardar;
    row.querySelector('.x').onclick = () => { const x = lotes(); x.splice(i, 1); lsSet('lotes', x); pintarLotes(); pintarDatos(); pintarCamara(); };
    cont.appendChild(row);
  });
}
function pintarDatalists() {
  $('dlNombres').innerHTML = lsGet('nombres', []).map((n) => `<option value="${esc(n)}">`).join('');
  $('dlClaves').innerHTML = [...new Set(['Lote', 'Notas', ...lsGet('claves', [])])].filter((k) => norm(k) !== 'dia del cultivo').map((n) => `<option value="${esc(n)}">`).join('');
}
function pintarTodo() {
  pintarCamara();
  if (!$('scrDatos').classList.contains('hidden')) pintarDatos();
}

/* ======================= galería y ficha ======================= */
let urlsGal = [];
async function pintarGaleria() {
  const q = norm($('inpBuscar').value);
  const todas = (await dbAll()).reverse();
  const lista = !q ? todas : todas.filter((f) => norm([lugarTexto(f), ...(f.personas || []), ...(f.extras || []).map((e) => e.k + ' ' + e.v), fmtFechaCorta(new Date(f.fecha))].join(' ')).includes(q));
  const g = $('grid'); g.innerHTML = '';
  lista.forEach((f) => {
    const c = document.createElement('button'); c.className = 'cel';
    c.style.backgroundImage = `url(${f.thumb})`;
    const cap = [(f.personas || [])[0], f.ciudad].filter(Boolean).join(' · ') || fmtFechaCorta(new Date(f.fecha));
    c.innerHTML = (f.origen === 'importada' ? '<span class="bdg">importada</span>' : '') + (f.ubicPendiente ? '<span class="pend">sin ubicación</span>' : '') + `<span class="cap">${esc(cap)}</span>`;
    c.onclick = () => abrirFicha(f.id);
    g.appendChild(c);
  });
  $('galVacia').classList.toggle('hidden', lista.length > 0);
  $('galVacia').textContent = todas.length ? 'Nada coincide con la búsqueda.' : 'Todavía no hay fotos.';
  revisarPendientes();
}
async function abrirFicha(id) {
  const f = await dbGet(id); if (!f) return;
  fichaActual = f;
  modoManual = false; $('hintManual').classList.add('hidden');
  await resugerir(f);
  urlsGal.forEach((u) => URL.revokeObjectURL(u)); urlsGal = [];
  const u = URL.createObjectURL(f.blob); urlsGal.push(u); $('fichaImg').src = u;
  const d = new Date(f.fecha);
  const filas = [
    ['Fecha', `${fmtFechaCorta(d)} · ${fmtHora(d, false)}` + (f.fechaRevisar ? ' (revisar)' : '')],
    ['Lugar', lugarTexto(f) || (f.ubicPendiente ? 'pendiente' : (f.geoInt ? 'se completa con internet' : '—'))],
    ['Altitud', fmtAlt(f.altitud) || '—'],
    ['Personas', [...new Set([...(f.personas || []), ...nombresConfirmados(f)])].join(', ') || '—'],
    ...(f.extras || []).map((e) => [e.k || 'Extra', e.v]),
  ];
  if (f.origen === 'importada') filas.push(['Origen', 'Importada de Fotos']);
  if (f.coords) filas.push(['Coordenadas', `${f.coords.lat.toFixed(6)}, ${f.coords.lon.toFixed(6)} (±${Math.round(f.coords.acc)} m)`]);
  $('fichaCampos').innerHTML = filas.map(([k, v]) => `<div class="f"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
  $('fichaPend').classList.toggle('hidden', !f.ubicPendiente);
  $('btnCompletarUbic').classList.toggle('hidden', geo.estado !== 'activa');
  $('fichaPendTxt').textContent = geo.estado === 'activa'
    ? 'Esta foto se tomó sin ubicación. Si sigues en el mismo sitio, complétala con la ubicación actual; si no, usa Editar para ponerla a mano.'
    : 'Esta foto se tomó sin ubicación. Activa la ubicación para completarla, o usa Editar para ponerla a mano.';
  $('btnFichaExacta').classList.toggle('hidden', !(f.geoInt || f.coords));
  mostrar('scrFicha');
  pintarCaras();
  prepararCompartir(f);
  if (!f.carasAnalizadas && !analizando.has(f.id) && !intentados.has(f.id)) { intentados.add(f.id); encolarAnalisis(f.id); }
}
let modoManual = false;
async function guardarFichaEditada() {
  const f = fichaActual; const { personas, extras } = limpiarListas();
  if (f.fechaRevisar && form.fechaManual && form.fechaManual !== f.fecha) f.fechaRevisar = false;
  f.fecha = fechaDelForm().toISOString();
  f.personas = personas;
  const dia = diaCultivo(extras, f.fecha);
  f.extras = extras.filter((e) => norm(e.k) !== 'dia del cultivo');
  if (dia !== null) f.extras.push({ k: 'Día del cultivo', v: String(dia), calc: true });
  if (form.ubicManual) {
    f.pais = form.pais; f.depto = form.depto; f.ciudad = form.ciudad; f.ubicManual = true;
    if (f.pais || f.depto || f.ciudad) f.ubicPendiente = false;
  }
  f.coords = form.coords ? { ...form.coords } : null;
  await reescribirFoto(f);
  recordarNombresYClaves(personas, extras);
  toast('Cambios guardados');
}
async function reescribirFoto(f) {
  const d = await blobADataURL(f.blob);
  f.blob = dataURLaBlob(escribirExif(d, f));
  await dbPut(f);
}
function nombreArchivo(f) {
  const d = new Date(f.fecha);
  const base = `FotoFicha_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return base + '.jpg';
}
async function compartirFoto(f, conTexto) {
  if (compartirListo.id !== f.id || !compartirListo.blob) { toast('Preparando la foto… toca otra vez en un segundo.'); if (compartirListo.id !== f.id) prepararCompartir(f); return; }
  const file = new File([compartirListo.blob], nombreArchivo(f), { type: 'image/jpeg' });
  const datos = { files: [file] }; if (conTexto) datos.text = textoFicha(f);
  if (navigator.canShare && navigator.canShare(datos)) {
    try { await navigator.share(datos); } catch (e) { /* cancelado */ }
  } else {
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  }
}

/* ======================= reconocimiento facial (face-api, todo dentro del teléfono) ======================= */
// Opción A aprobada por Mojon (30-sep): detecta caras, SUGIERE nombre solo con alta seguridad ("Nombre ?"),
// nada queda confirmado sin un toque del usuario, y cada confirmación enseña a la app.
// Prueba 30-sep: personas distintas llegaron a distancia 0.476 -> umbral estricto + margen contra el 2º candidato.
const UMBRAL_CARA = 0.45, MARGEN_CARA = 0.08;
let faceListo = null, colaCaras = Promise.resolve(), errorCaras = '';
const analizando = new Set(), intentados = new Set(); // intentados: evita reintentar en bucle si falla
function cargarFaceApi() {
  if (faceListo) return faceListo;
  faceListo = (async () => {
    if (!window.faceapi) {
      await new Promise((res, rej) => {
        const s = document.createElement('script'); s.src = 'lib/face-api.js';
        s.onload = res; s.onerror = () => rej(new Error('no se pudo cargar el motor de caras')); document.head.appendChild(s);
      });
    }
    let ok = false;
    try { ok = await faceapi.tf.setBackend('webgl'); } catch (e) { ok = false; }
    if (!ok) await faceapi.tf.setBackend('cpu');
    await faceapi.tf.ready();
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri('models'),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri('models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('models'),
    ]);
    return true;
  })();
  faceListo.catch(() => { faceListo = null; });
  return faceListo;
}
function cargarImagen(blob) {
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(blob); const img = new Image();
    img.onload = () => { URL.revokeObjectURL(u); res(img); }; img.onerror = rej; img.src = u;
  });
}
async function detectarCaras(blob) {
  await cargarFaceApi();
  const img = await cargarImagen(blob);
  const k = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const r = await faceapi.detectAllFaces(c, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 })).withFaceLandmarks(true).withFaceDescriptors();
  return r.map((x) => {
    const b = x.detection.box;
    return { x: b.x / c.width, y: b.y / c.height, w: b.width / c.width, h: b.height / c.height, desc: Array.from(x.descriptor), nombre: '', estado: '' };
  }).sort((a, b) => a.x - b.x);
}
function distCara(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }
async function rostrosConocidos(excluirId) {
  const out = {};
  for (const f of await dbAll()) {
    if (f.id === excluirId) continue;
    (f.caras || []).forEach((c) => { if (c.estado === 'confirmado' && c.nombre && c.desc) (out[c.nombre] = out[c.nombre] || []).push(c.desc); });
  }
  return out;
}
/* Pone "sugerido" solo si el mejor candidato está muy cerca y claramente mejor que el segundo. Devuelve cuántas cambió. */
function sugerirNombres(caras, conocidos) {
  const nombres = Object.keys(conocidos); if (!nombres.length) return 0;
  const cands = [];
  caras.forEach((c, i) => {
    if (c.estado === 'confirmado' || c.estado === 'descartado' || !c.desc) return;
    const orden = nombres.map((n) => [n, Math.min(...conocidos[n].map((d) => distCara(c.desc, d)))]).sort((a, b) => a[1] - b[1]);
    const [n1, d1] = orden[0]; const d2 = orden[1] ? orden[1][1] : Infinity;
    if (d1 < UMBRAL_CARA && d2 - d1 >= MARGEN_CARA) cands.push({ i, n: n1, d: d1 });
  });
  cands.sort((a, b) => a.d - b.d);
  const usados = new Set(caras.filter((c) => c.estado === 'confirmado').map((c) => norm(c.nombre)));
  let cambios = 0;
  caras.forEach((c) => { if (c.estado === 'sugerido') { c.estado = ''; c.nombre = ''; } });
  for (const k of cands) {
    if (usados.has(norm(k.n))) continue;
    caras[k.i].nombre = k.n; caras[k.i].estado = 'sugerido'; caras[k.i].dist = Math.round(k.d * 1000) / 1000;
    usados.add(norm(k.n)); cambios++;
  }
  return cambios;
}
function encolarAnalisis(id) { colaCaras = colaCaras.then(() => analizarFoto(id)).catch(() => {}); return colaCaras; }
async function analizarFoto(id) {
  if (analizando.has(id)) return;
  analizando.add(id); errorCaras = '';
  if (fichaActual && fichaActual.id === id) pintarCaras();
  try {
    const f = await dbGet(id); if (!f) return;
    const caras = await detectarCaras(f.blob);
    sugerirNombres(caras, await rostrosConocidos(id));
    const g = await dbGet(id); if (!g) return;
    g.caras = caras; g.carasAnalizadas = true; await dbPut(g);
  } catch (e) { console.warn('caras', e); errorCaras = e.message || String(e); }
  finally {
    analizando.delete(id);
    if (fichaActual && fichaActual.id === id && !$('scrFicha').classList.contains('hidden')) abrirFicha(id);
  }
}
/* Al abrir una ficha: vuelve a sugerir con lo que la app aprendió desde entonces (sin volver a detectar). */
async function resugerir(f) {
  if (!f.caras || !f.caras.some((c) => !c.estado || c.estado === 'sugerido')) return false;
  const antes = JSON.stringify(f.caras.map((c) => [c.nombre, c.estado]));
  sugerirNombres(f.caras, await rostrosConocidos(f.id));
  if (JSON.stringify(f.caras.map((c) => [c.nombre, c.estado])) === antes) return false;
  await dbPut(f); return true;
}
function nombresConfirmados(f) {
  return [...(f.caras || []).filter((c) => c.estado === 'confirmado' && c.nombre).map((c) => c.nombre),
    ...(f.manuales || []).filter((m) => m.nombre).map((m) => m.nombre)];
}
function pintarCaras() {
  const f = fichaActual; if (!f) return;
  const capa = $('capaNombres'); capa.innerHTML = '';
  const ver = lsGet('mostrarNombres', true);
  $('swNombres').classList.toggle('off', !ver); $('swNombres').setAttribute('aria-checked', String(ver));
  capa.classList.toggle('oculta', !ver);
  const caras = f.caras || [];
  caras.forEach((c, i) => {
    if (c.estado === 'descartado') return;
    const box = document.createElement('div'); box.className = 'fbox' + (c.estado === 'confirmado' ? ' ok' : '');
    Object.assign(box.style, { left: c.x * 100 + '%', top: c.y * 100 + '%', width: c.w * 100 + '%', height: c.h * 100 + '%' });
    const l = document.createElement('button');
    l.className = 'lblc' + (c.estado === 'sugerido' ? ' sug' : '') + (!c.nombre ? ' nn' : '');
    l.textContent = !c.nombre ? '¿Quién es?' : (c.estado === 'sugerido' ? c.nombre + ' ?' : c.nombre);
    l.style.left = (c.x + c.w / 2) * 100 + '%'; l.style.top = Math.min(0.93, c.y + c.h) * 100 + '%';
    l.onclick = (e) => { e.stopPropagation(); elegirNombre({ tipo: 'cara', i }); };
    capa.append(box, l);
  });
  (f.manuales || []).forEach((m, i) => {
    const l = document.createElement('button'); l.className = 'lblc man';
    l.textContent = m.nombre; l.style.left = m.x * 100 + '%'; l.style.top = Math.min(0.93, m.y) * 100 + '%';
    l.onclick = (e) => { e.stopPropagation(); elegirNombre({ tipo: 'manual', i }); };
    capa.appendChild(l);
  });
  const vis = caras.filter((c) => c.estado !== 'descartado');
  let txt = '';
  if (analizando.has(f.id)) txt = faceListo ? 'Buscando caras…' : 'Preparando el reconocimiento de caras (la primera vez tarda más)…';
  else if (errorCaras && !f.carasAnalizadas) txt = 'No se pudieron buscar caras: ' + errorCaras + '. Puedes poner los nombres a mano.';
  else if (f.carasAnalizadas) {
    const sug = vis.filter((c) => c.estado === 'sugerido').length, sin = vis.filter((c) => !c.nombre).length;
    txt = vis.length ? `${vis.length} cara${vis.length > 1 ? 's' : ''}` + (sug ? ` · ${sug} por confirmar (toca el nombre con ?)` : '') + (sin ? ` · ${sin} sin nombre (toca "¿Quién es?")` : '')
      : 'No se encontraron caras. Si hay personas, usa "＋ Nombre a mano".';
  }
  $('estadoCaras').textContent = txt;
  $('btnDetectar').classList.toggle('hidden', analizando.has(f.id) || !!f.carasAnalizadas);
}
/* Ventana para elegir el nombre de una cara o etiqueta */
function elegirNombre(obj) {
  const f = fichaActual;
  const actual = obj.tipo === 'cara' ? f.caras[obj.i] : obj.tipo === 'manual' ? f.manuales[obj.i] : null;
  const puestos = new Set(nombresConfirmados(f).map(norm));
  const lista = [...new Set([...(f.personas || []), ...lsGet('nombres', []).slice().reverse()])]
    .filter((n) => n && !(puestos.has(norm(n)) && !(actual && norm(actual.nombre) === norm(n)))).slice(0, 12);
  const box = $('modalTxt'); const btns = $('modalBtns');
  box.innerHTML = `<b>${actual && actual.estado === 'sugerido' ? '¿Es ' + esc(actual.nombre) + '?' : '¿Quién es?'}</b>
    <div class="sug" style="padding:10px 0 4px">${lista.map((n) => `<button data-n="${esc(n)}">${esc(n)}</button>`).join('')}</div>
    <div class="inp" style="background:var(--field);border-radius:10px;margin-top:6px"><input id="inpOtroNombre" list="dlNombres" placeholder="Otro nombre…" autocomplete="off" autocapitalize="words"></div>`;
  btns.innerHTML = ''; btns.style.flexWrap = 'wrap';
  const cerrar = () => { $('modal').classList.add('hidden'); btns.style.flexWrap = ''; };
  const boton = (txt, fn, pri) => { const b = document.createElement('button'); b.className = 'btn' + (pri ? ' pri' : ''); b.textContent = txt; b.onclick = () => { cerrar(); fn(); }; btns.appendChild(b); };
  box.querySelectorAll('[data-n]').forEach((b) => { b.onclick = () => { cerrar(); asignarNombre(obj, b.dataset.n); }; });
  if (actual && actual.estado === 'sugerido') boton('Sí, es ' + actual.nombre, () => asignarNombre(obj, actual.nombre), true);
  boton('Usar el nombre escrito', () => { const v = ($('inpOtroNombre').value || '').trim(); if (v) asignarNombre(obj, v); });
  if (obj.tipo === 'cara') boton(actual && actual.nombre ? 'Quitar nombre' : 'No es una persona', () => asignarNombre(obj, actual && actual.nombre ? '' : null));
  if (obj.tipo === 'manual') boton('Quitar etiqueta', () => asignarNombre(obj, null));
  boton('Cancelar', () => {});
  $('modal').classList.remove('hidden');
}
/* nombre: texto = confirmar; '' = dejar sin nombre; null = descartar (no es persona / quitar etiqueta) */
async function asignarNombre(obj, nombre) {
  const f = fichaActual;
  if (obj.tipo === 'cara') {
    const c = f.caras[obj.i];
    if (nombre) {
      f.caras.forEach((o, j) => { if (j !== obj.i && o.nombre && norm(o.nombre) === norm(nombre)) { o.nombre = ''; o.estado = ''; } });
      c.nombre = nombre; c.estado = 'confirmado';
    } else if (nombre === '') { c.nombre = ''; c.estado = ''; } else { c.nombre = ''; c.estado = 'descartado'; }
  } else if (obj.tipo === 'manual') {
    if (nombre) f.manuales[obj.i].nombre = nombre; else f.manuales.splice(obj.i, 1);
  } else if (obj.tipo === 'nuevo' && nombre) {
    (f.manuales = f.manuales || []).push({ x: obj.x, y: obj.y, nombre });
  }
  if (nombre) {
    f.personas = f.personas || [];
    if (!f.personas.some((p) => norm(p) === norm(nombre))) f.personas.push(nombre);
    recordarNombresYClaves([nombre], []);
  }
  await reescribirFoto(f);
  abrirFicha(f.id);
}
/* Copia para Fotos/Compartir: con el interruptor activado lleva escritos los nombres confirmados */
let compartirListo = { id: null, blob: null };
async function prepararCompartir(f) {
  compartirListo = { id: f.id, blob: null };
  let blob = f.blob;
  const etiquetas = [
    ...(f.caras || []).filter((c) => c.estado === 'confirmado' && c.nombre).map((c) => ({ t: c.nombre, x: c.x + c.w / 2, y: c.y + c.h })),
    ...(f.manuales || []).filter((m) => m.nombre).map((m) => ({ t: m.nombre, x: m.x, y: m.y })),
  ];
  if (lsGet('mostrarNombres', true) && etiquetas.length) {
    try {
      const img = await cargarImagen(f.blob);
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const fs = Math.max(16, Math.round(c.width * 0.03)); const pd = Math.round(fs * 0.35);
      g.font = `600 ${fs}px -apple-system, "Segoe UI", Roboto, sans-serif`; g.textBaseline = 'top';
      etiquetas.forEach((e) => {
        const w = g.measureText(e.t).width + pd * 2, h = fs + pd * 2;
        let x = e.x * c.width - w / 2, y = Math.min(e.y * c.height + pd, c.height - h - 2);
        x = Math.max(2, Math.min(x, c.width - w - 2));
        g.fillStyle = 'rgba(0,0,0,0.72)';
        if (g.roundRect) { g.beginPath(); g.roundRect(x, y, w, h, pd); g.fill(); } else g.fillRect(x, y, w, h);
        g.fillStyle = '#fff'; g.fillText(e.t, x + pd, y + pd);
      });
      blob = dataURLaBlob(escribirExif(c.toDataURL('image/jpeg', 0.92), f));
    } catch (e) { console.warn('nombres en copia', e); }
  }
  if (compartirListo.id === f.id) compartirListo.blob = blob;
}

/* ======================= importar desde Fotos (fotos ya tomadas) ======================= */
// Límite de Apple: una web app no puede ver la fototeca sola; el usuario elige las fotos con el selector.
// Se lee de la foto: fecha de toma (EXIF) y GPS si iOS lo entrega. El resto queda para completar a mano.
function exifFecha(ex) {
  const t = ex && ex.Exif && (ex.Exif[piexif.ExifIFD.DateTimeOriginal] || ex.Exif[piexif.ExifIFD.DateTimeDigitized]);
  const m = t && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(t);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]); // hora local de la toma
  return isNaN(d) ? null : d;
}
function exifGPS(ex) {
  const g = ex && ex.GPS; if (!g) return null;
  const aDec = (v) => v && v.length === 3 ? v[0][0] / v[0][1] + v[1][0] / v[1][1] / 60 + v[2][0] / v[2][1] / 3600 : NaN;
  let lat = aDec(g[piexif.GPSIFD.GPSLatitude]), lon = aDec(g[piexif.GPSIFD.GPSLongitude]);
  if (isNaN(lat) || isNaN(lon) || (lat === 0 && lon === 0)) return null;
  if (g[piexif.GPSIFD.GPSLatitudeRef] === 'S') lat = -lat;
  if (g[piexif.GPSIFD.GPSLongitudeRef] === 'W') lon = -lon;
  const a = g[piexif.GPSIFD.GPSAltitude]; let alt = a ? a[0] / a[1] : null;
  if (alt !== null && g[piexif.GPSIFD.GPSAltitudeRef] === 1) alt = -alt;
  return { lat, lon, alt };
}
async function huellaArchivo(buf) {
  try { const h = await crypto.subtle.digest('SHA-256', buf); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
  catch (e) { return null; }
}
let importCancelado = false;
async function importarFotos(files) {
  files = [...files]; if (!files.length) return;
  importCancelado = false; mostrar('scrImportar');
  const lista = $('impLista'); lista.innerHTML = '';
  const hashes = new Set((await dbAll()).map((f) => f.origenHash).filter(Boolean));
  let hechas = 0, repetidas = 0;
  const avance = () => {
    $('impTitulo').textContent = hechas < files.length ? `Importando ${hechas + 1} de ${files.length}` : `Listo: ${files.length - repetidas} importada${files.length - repetidas === 1 ? '' : 's'}`;
    $('impBarra').style.width = Math.round(hechas / files.length * 100) + '%';
  };
  avance();
  for (const file of files) {
    if (importCancelado) break;
    const item = document.createElement('div'); item.className = 'item';
    item.innerHTML = '<div class="th"></div><div class="txt">Leyendo…</div>'; lista.prepend(item);
    const txt = item.querySelector('.txt');
    try {
      const buf = await file.arrayBuffer();
      const hash = await huellaArchivo(buf);
      if (hash && hashes.has(hash)) { repetidas++; txt.innerHTML = '<span class="no">Ya estaba importada: no se duplica.</span>'; hechas++; avance(); continue; }
      let ex = null; const original = await blobADataURL(new Blob([buf], { type: file.type || 'image/jpeg' }));
      if (/^data:image\/jpe?g/i.test(original)) { try { ex = piexif.load(original); } catch (e) { ex = null; } }
      const fTom = exifFecha(ex); const gps = exifGPS(ex);
      const fecha = fTom || new Date(file.lastModified || Date.now());
      const jpg = await archivoADataURL(file);
      const r = {
        uid: uid(), origen: 'importada', origenHash: hash, fecha: fecha.toISOString(), fechaRevisar: !fTom,
        pais: '', depto: '', ciudad: '', altitud: gps ? gps.alt : null, ubicManual: false,
        geoInt: gps ? { lat: gps.lat, lon: gps.lon, acc: null } : null, ubicPendiente: !gps, coords: null,
        personas: [], extras: [],
      };
      if (gps) {
        try { Object.assign(r, await reverseGeocode(gps.lat, gps.lon)); await new Promise((ok) => setTimeout(ok, 1100)); }
        catch (e) { /* sin internet: se completa después (completarCiudadesSinRed) */ }
      }
      const conExif = escribirExif(jpg, r);
      r.blob = dataURLaBlob(conExif); r.thumb = await miniatura(conExif);
      r.id = await dbPut(r); if (hash) hashes.add(hash);
      item.querySelector('.th').style.backgroundImage = `url(${r.thumb})`;
      const lFecha = fTom ? `<span class="ok">✓ Fecha de la foto:</span> ${fmtFechaCorta(fecha)} ${fmtHora(fecha, false)}`
        : `<span class="no">✗ La foto no trae fecha:</span> se usó ${fmtFechaCorta(fecha)} (revisar)`;
      const lUbic = gps ? `<span class="ok">✓ Ubicación:</span> ${esc(lugarTexto(r) || 'se completa con internet')}`
        : '<span class="no">✗ Ubicación:</span> la foto no la trae → pendiente';
      txt.innerHTML = `${lFecha}<br>${lUbic}<br><span class="caras">Buscando caras…</span>`;
      encolarAnalisis(r.id).then(async () => {
        const g = await dbGet(r.id); const cs = (g && g.caras) || [];
        const el = txt.querySelector('.caras'); if (!el) return;
        if (!g || !g.carasAnalizadas) { el.innerHTML = '<span class="no">No se pudieron buscar caras (se reintenta al abrir la ficha)</span>'; return; }
        el.innerHTML = cs.length ? `<span class="ok">✓ ${cs.length} cara${cs.length > 1 ? 's' : ''}:</span> ` + esc(cs.map((c) => c.nombre ? c.nombre + ' ?' : '¿Quién es?').join(', '))
          : 'Sin caras detectadas';
      });
    } catch (e) { txt.innerHTML = '<span class="no">No se pudo importar: ' + esc(e.message || String(e)) + '</span>'; }
    hechas++; avance();
  }
  pintarUltima(); revisarPendientes();
}

/* ======================= respaldo ======================= */
async function exportar() {
  const todas = await dbAll();
  if (!todas.length) { toast('No hay fotos para respaldar.'); return; }
  toast('Preparando respaldo…', 6000);
  const fotos = [];
  for (const f of todas) { const { blob, id, ...resto } = f; fotos.push({ ...resto, imagen: await blobADataURL(blob) }); }
  const json = JSON.stringify({ app: 'FotoFicha', version: VERSION, creado: new Date().toISOString(), lotes: lotes(), fotos });
  const d = new Date();
  const file = new File([json], `FotoFicha_respaldo_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (e) { /* cancelado */ }
  } else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); }
}
async function importar(file) {
  try {
    const j = JSON.parse(await file.text());
    if (j.app !== 'FotoFicha' || !Array.isArray(j.fotos)) throw new Error('no es un respaldo de FotoFicha');
    const existentes = new Set((await dbAll()).map((f) => f.uid));
    let n = 0;
    for (const f of j.fotos) {
      if (existentes.has(f.uid)) continue;
      const { imagen, ...resto } = f; await dbPut({ ...resto, blob: dataURLaBlob(imagen) }); n++;
    }
    if (Array.isArray(j.lotes) && !lotes().length) lsSet('lotes', j.lotes);
    toast(`Importadas ${n} fotos (${j.fotos.length - n} ya estaban).`, 3500);
    pintarGaleria(); pintarUltima();
  } catch (e) { toast('No se pudo importar: ' + e.message, 4000); }
}

/* ======================= navegación ======================= */
function mostrar(id) {
  ['scrDatos', 'scrGaleria', 'scrFicha', 'scrImportar'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
}
function abrirDatos(modo) {
  modoDatos = modo;
  if (modo === 'editar') {
    const f = fichaActual;
    form = {
      fechaManual: f.fecha, ubicManual: false, pais: f.pais || '', depto: f.depto || '', ciudad: f.ciudad || '',
      altitud: f.altitud, coords: f.coords ? { ...f.coords } : null,
      personas: f.personas && f.personas.length ? f.personas.slice() : [''],
      extras: (f.extras || []).filter((e) => !e.calc).map((e) => ({ ...e })),
    };
    if (!form.extras.length) form.extras.push({ k: '', v: '' });
  }
  pintarPersonas(); pintarExtras(); pintarLotes(); pintarDatos();
  mostrar('scrDatos');
  $('scrDatos').querySelector('.sh-body').scrollTop = 0;
}
/* Lee lo escrito directamente de las casillas (en iPhone el último cambio del teclado puede no haber disparado 'input') */
function sincronizarDOM() {
  if ($('scrDatos').classList.contains('hidden')) return;
  const ps = [...$('listaPersonas').querySelectorAll('input')].map((i) => i.value);
  if (ps.length) form.personas = ps;
  const ex = [...$('listaExtras').querySelectorAll('.kv')].map((r) => { const [k, v] = r.querySelectorAll('input'); return { k: k.value, v: v.value }; });
  if (ex.length) form.extras = ex;
  if (form.ubicManual) { form.pais = $('inpPais').value; form.depto = $('inpDepto').value; form.ciudad = $('inpCiudad').value; }
}
async function cerrarDatos() {
  sincronizarDOM();
  if (modoDatos === 'editar') { // "Listo" también guarda (antes descartaba: error reportado 30-sep)
    await guardarFichaEditada(); const id = fichaActual.id;
    form = formGuardado; modoDatos = 'nueva'; abrirFicha(id); return;
  }
  mostrar(null); pintarCamara();
}
let formGuardado = null;

/* ======================= eventos ======================= */
function conectar() {
  $('tagCerrada').onclick = () => { tagAbierta = true; pintarCamara(); };
  $('btnCerrarTag').onclick = () => { tagAbierta = false; pintarCamara(); };
  $('btnEditarDatos').onclick = () => abrirDatos('nueva');
  $('chipUbic').onclick = () => { if (geo.estado !== 'activa') activarUbicacion(); };
  $('chipPend').onclick = () => { mostrar('scrGaleria'); pintarGaleria(); };
  $('btnDisparar').onclick = () => tomarFoto();
  $('btnGirar').onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; iniciarCamara(); };
  $('btnGaleria').onclick = () => { mostrar('scrGaleria'); pintarGaleria(); };
  $('btnReintentarCam').onclick = iniciarCamara;
  $('inpCapturaNativa').onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    tomarFoto(await archivoADataURL(file));
  };

  $('btnDatosListo').onclick = cerrarDatos;
  $('btnGuardarDatos').onclick = async () => {
    if (modoDatos === 'editar') return cerrarDatos();
    sincronizarDOM(); mostrar(null); setTimeout(() => tomarFoto(), 150);
  };
  $('inpFecha').onchange = () => { if ($('inpFecha').value) { form.fechaManual = new Date($('inpFecha').value).toISOString(); pintarDatos(); pintarCamara(); } };
  $('btnFechaAuto').onclick = () => { form.fechaManual = null; pintarDatos(); pintarCamara(); };
  $('btnActivarUbic').onclick = activarUbicacion;
  $('btnUbicManual').onclick = () => { form.ubicManual = true; $('inpPais').value = form.pais; $('inpDepto').value = form.depto; $('inpCiudad').value = form.ciudad; pintarDatos(); pintarCamara(); $('inpPais').focus(); };
  $('btnEditarUbic').onclick = () => {
    if (!form.ubicManual) {
      const l = lugarDelForm(); form.ubicManual = true;
      form.pais = form.pais || l.pais; form.depto = form.depto || l.depto; form.ciudad = form.ciudad || l.ciudad;
      $('inpPais').value = form.pais; $('inpDepto').value = form.depto; $('inpCiudad').value = form.ciudad;
    } else if (modoDatos === 'nueva') { form.ubicManual = false; form.pais = form.depto = form.ciudad = ''; }
    else { form.ubicManual = true; }
    pintarDatos(); pintarCamara();
  };
  ['Pais', 'Depto', 'Ciudad'].forEach((k) => { $('inp' + k).oninput = () => { form[k.toLowerCase()] = $('inp' + k).value; pintarCamara(); }; });
  $('btnUbicExacta').onclick = () => {
    const src = modoDatos === 'editar' ? (fichaActual.coords || fichaActual.geoInt) : geo.fix;
    if (!src) { toast('Todavía no hay ubicación.'); return; }
    form.coords = { lat: src.lat, lon: src.lon, acc: src.acc };
    pintarDatos();
    abrirGoogleMaps(src.lat, src.lon);
  };
  $('btnQuitarCoords').onclick = () => { form.coords = null; pintarDatos(); };
  $('btnAddPersona').onclick = () => { form.personas.push(''); pintarPersonas(); const ins = $('listaPersonas').querySelectorAll('input'); ins[ins.length - 1].focus(); };
  $('btnAddExtra').onclick = () => { form.extras.push({ k: '', v: '' }); pintarExtras(); const ins = $('listaExtras').querySelectorAll('input'); ins[ins.length - 2].focus(); };
  $('btnAddLote').onclick = () => { const x = lotes(); x.push({ nombre: '', siembra: '' }); lsSet('lotes', x); pintarLotes(); };

  $('btnGalVolver').onclick = () => mostrar(null);
  $('inpBuscar').oninput = pintarGaleria;
  $('btnExportar').onclick = exportar;
  $('inpImportar').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importar(f); };
  $('inpImportarFotos').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; importarFotos(fs); };
  $('btnImpCerrar').onclick = () => { importCancelado = true; mostrar('scrGaleria'); pintarGaleria(); };

  $('btnFichaVolver').onclick = () => { mostrar('scrGaleria'); pintarGaleria(); };
  $('btnFichaEditar').onclick = () => { formGuardado = form; abrirDatos('editar'); };
  $('btnFichaFotos').onclick = () => compartirFoto(fichaActual, false);
  $('swNombres').onclick = () => { lsSet('mostrarNombres', !lsGet('mostrarNombres', true)); pintarCaras(); prepararCompartir(fichaActual); };
  $('btnDetectar').onclick = () => { errorCaras = ''; encolarAnalisis(fichaActual.id); pintarCaras(); };
  $('btnNombreManual').onclick = () => {
    modoManual = true; $('hintManual').classList.remove('hidden');
    if (!lsGet('mostrarNombres', true)) { lsSet('mostrarNombres', true); pintarCaras(); }
  };
  $('btnCancelarManual').onclick = () => { modoManual = false; $('hintManual').classList.add('hidden'); };
  $('fotoWrap').onclick = (e) => {
    if (!modoManual) return;
    const r = $('fichaImg').getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    modoManual = false; $('hintManual').classList.add('hidden');
    elegirNombre({ tipo: 'nuevo', x, y: Math.min(1, y + 0.03) });
  };
  $('btnFichaCompartir').onclick = () => compartirFoto(fichaActual, true);
  $('btnFichaExacta').onclick = async () => {
    const f = fichaActual; const src = f.coords || f.geoInt;
    if (!f.coords) { f.coords = { ...src }; await reescribirFoto(f); } // al tocarlo se llenan las coordenadas
    abrirGoogleMaps(src.lat, src.lon);
    setTimeout(() => abrirFicha(f.id), 300);
  };
  $('btnCompletarUbic').onclick = async () => {
    if (geo.estado !== 'activa' || !geo.fix) { toast('No hay ubicación activa.'); return; }
    const f = fichaActual;
    f.geoInt = { lat: geo.fix.lat, lon: geo.fix.lon, acc: geo.fix.acc };
    f.altitud = geo.fix.alt; f.ubicPendiente = false; f.ubicManual = false;
    if (lugarAuto.desde && distM(lugarAuto.desde, geo.fix) < 300) Object.assign(f, { pais: lugarAuto.pais, depto: lugarAuto.depto, ciudad: lugarAuto.ciudad });
    else { try { Object.assign(f, await reverseGeocode(geo.fix.lat, geo.fix.lon)); } catch (e) { /* se completa después */ } }
    await reescribirFoto(f); toast('Ubicación completada'); abrirFicha(f.id); revisarPendientes();
  };
  $('btnBorrar').onclick = async () => {
    const ok = await modal('<b>¿Borrar esta foto y su ficha?</b><p class="nota">No se puede deshacer. Si ya la guardaste en Fotos, esa copia se queda.</p>',
      [{ txt: 'Cancelar', val: false }, { txt: 'Borrar', val: true, pri: true }]);
    if (!ok) return;
    await dbDel(fichaActual.id); toast('Borrada'); mostrar('scrGaleria'); pintarGaleria(); pintarUltima();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!stream || stream.getVideoTracks().every((t) => t.readyState === 'ended')) iniciarCamara();
      if (geo.estado !== 'activa') iniciarGeo();
      completarCiudadesSinRed();
    }
  });
  window.addEventListener('online', () => { if (geo.fix && !lugarAuto.ciudad) geocodificar(geo.fix); completarCiudadesSinRed(); });
  setInterval(() => { if (!form.fechaManual) pintarTodo(); }, 1000);
}

/* ======================= arranque ======================= */
async function main() {
  try { await abrirDB(); } catch (e) { toast('No se pudo abrir el almacenamiento: ' + e.message, 6000); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  form = formNuevo();
  conectar(); pintarDatalists(); pintarTodo();
  iniciarCamara(); iniciarGeo();
  pintarUltima(); revisarPendientes(); completarCiudadesSinRed();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
main();
