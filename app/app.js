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
  try { await dbPut(r); } catch (e) { toast('No se pudo guardar: ' + e.message, 4000); return; }
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
    c.innerHTML = (f.ubicPendiente ? '<span class="pend">sin ubicación</span>' : '') + `<span class="cap">${esc(cap)}</span>`;
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
  urlsGal.forEach((u) => URL.revokeObjectURL(u)); urlsGal = [];
  const u = URL.createObjectURL(f.blob); urlsGal.push(u); $('fichaImg').src = u;
  const d = new Date(f.fecha);
  const filas = [
    ['Fecha', `${fmtFechaCorta(d)} · ${fmtHora(d, false)}`],
    ['Lugar', lugarTexto(f) || (f.ubicPendiente ? 'pendiente' : (f.geoInt ? 'se completa con internet' : '—'))],
    ['Altitud', fmtAlt(f.altitud) || '—'],
    ['Personas', (f.personas || []).join(', ') || '—'],
    ...(f.extras || []).map((e) => [e.k || 'Extra', e.v]),
  ];
  if (f.coords) filas.push(['Coordenadas', `${f.coords.lat.toFixed(6)}, ${f.coords.lon.toFixed(6)} (±${Math.round(f.coords.acc)} m)`]);
  $('fichaCampos').innerHTML = filas.map(([k, v]) => `<div class="f"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
  $('fichaPend').classList.toggle('hidden', !f.ubicPendiente);
  $('btnCompletarUbic').classList.toggle('hidden', geo.estado !== 'activa');
  $('fichaPendTxt').textContent = geo.estado === 'activa'
    ? 'Esta foto se tomó sin ubicación. Si sigues en el mismo sitio, complétala con la ubicación actual; si no, usa Editar para ponerla a mano.'
    : 'Esta foto se tomó sin ubicación. Activa la ubicación para completarla, o usa Editar para ponerla a mano.';
  $('btnFichaExacta').classList.toggle('hidden', !(f.geoInt || f.coords));
  mostrar('scrFicha');
}
async function guardarFichaEditada() {
  const f = fichaActual; const { personas, extras } = limpiarListas();
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
  const file = new File([f.blob], nombreArchivo(f), { type: 'image/jpeg' });
  const datos = { files: [file] }; if (conTexto) datos.text = textoFicha(f);
  if (navigator.canShare && navigator.canShare(datos)) {
    try { await navigator.share(datos); } catch (e) { /* cancelado */ }
  } else {
    const a = document.createElement('a'); a.href = URL.createObjectURL(f.blob); a.download = file.name; a.click();
  }
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
  ['scrDatos', 'scrGaleria', 'scrFicha'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
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
function cerrarDatos() {
  if (modoDatos === 'editar') { form = formGuardado; modoDatos = 'nueva'; mostrar('scrFicha'); return; }
  mostrar(null);
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
    if (modoDatos === 'editar') {
      await guardarFichaEditada(); const id = fichaActual.id;
      form = formGuardado; modoDatos = 'nueva'; abrirFicha(id); return;
    }
    mostrar(null); setTimeout(() => tomarFoto(), 150);
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

  $('btnFichaVolver').onclick = () => { mostrar('scrGaleria'); pintarGaleria(); };
  $('btnFichaEditar').onclick = () => { formGuardado = form; abrirDatos('editar'); };
  $('btnFichaFotos').onclick = () => compartirFoto(fichaActual, false);
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
