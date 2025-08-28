// Firebase CDN imports (v10+ modular)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, addDoc, collection,
  onSnapshot, serverTimestamp, query, orderBy, where, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

// ---- Firebase Config (from you) ----
const firebaseConfig = {
  apiKey: "AIzaSyBnVNIMeJxm_fXcpfBGg-BbdIe5WL8drXg",
  authDomain: "new-app-9fbd8.firebaseapp.com",
  projectId: "new-app-9fbd8",
  storageBucket: "new-app-9fbd8.firebasestorage.app",
  messagingSenderId: "784160013930",
  appId: "1:784160013930:web:2a44217c7e4c435a951413"
};

// ---- Init Firebase ----
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---- Helpers ----
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const qs = params => new URLSearchParams(params).toString();
function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ---- State ----
let user = null;
let boardId = new URLSearchParams(location.search).get("board");
let boardRef = null;
let currentPageId = null;
let pages = [];
let strokes = [];      // local cache for render
let objects = [];      // text/shapes/sticky/images
let undoStack = [];
let redoStack = [];
let tool = "select";
let isPanning = false;
let isLaser = false;
let recording = false;
let mediaRecorder = null;
let recordedChunks = [];

let zoom = 1;
let offset = { x: 0, y: 0 };
const stage = $(".stage");
const canvas = $("#board");
const ctx = canvas.getContext("2d");
const textEditor = $("#textEditor");

// logical canvas size
const CANVAS_W = 1920;
const CANVAS_H = 1080;

function resetView() {
  zoom = Math.min(stage.clientWidth / CANVAS_W, stage.clientHeight / CANVAS_H);
  const fitW = (stage.clientWidth - CANVAS_W * zoom) / 2;
  const fitH = (stage.clientHeight - CANVAS_H * zoom) / 2;
  offset.x = fitW;
  offset.y = fitH;
  draw();
}
window.addEventListener("resize", resetView);

// ---- Auth UI ----
const authBtn = $("#authBtn");
const avatar = $("#userAvatar");
authBtn.addEventListener("click", async () => {
  if (!user) {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  } else {
    await signOut(auth);
  }
});
onAuthStateChanged(auth, async (u) => {
  user = u;
  if (user) {
    authBtn.textContent = "Sign out";
    avatar.src = user.photoURL || "";
    await ensureBoard();
  } else {
    authBtn.textContent = "Sign in";
    avatar.removeAttribute("src");
    // still allow viewing if board exists
    await ensureBoard(true);
  }
});

// ---- Board bootstrap ----
async function ensureBoard(viewOnly = false) {
  if (!boardId) {
    // create new board if signed in
    if (!user) {
      // wait until sign-in
      return;
    }
    boardId = uid();
    history.replaceState({}, "", `?${qs({ board: boardId })}`);
    boardRef = doc(db, "boards", boardId);
    await setDoc(boardRef, {
      title: "Untitled Board",
      ownerId: user.uid,
      allowEdit: true,
      createdAt: serverTimestamp(),
      passcode: ""
    });
    const page1 = await addDoc(collection(boardRef, "pages"), {
      index: 0, createdAt: serverTimestamp(), bg: "#0A1524"
    });
    currentPageId = page1.id;
  } else {
    boardRef = doc(db, "boards", boardId);
    const snap = await getDoc(boardRef);
    if (!snap.exists()) {
      // create board if signed in; else show error
      if (!user) return;
      await setDoc(boardRef, {
        title: "Untitled Board",
        ownerId: user.uid,
        allowEdit: true,
        createdAt: serverTimestamp(),
        passcode: ""
      });
      const page1 = await addDoc(collection(boardRef, "pages"), {
        index: 0, createdAt: serverTimestamp(), bg: "#0A1524"
      });
      currentPageId = page1.id;
    } else {
      $("#boardTitle").value = snap.data().title || "Untitled Board";
    }
  }
  bindRealtime();
  resetView();
  setupPresence();
}

// ---- Realtime listeners ----
function bindRealtime() {
  // pages
  const pagesQ = query(collection(boardRef, "pages"), orderBy("index", "asc"));
  onSnapshot(pagesQ, (qsnap) => {
    pages = [];
    qsnap.forEach(docSnap => pages.push({ id: docSnap.id, ...docSnap.data() }));
    if (!currentPageId && pages.length) currentPageId = pages[0].id;
    renderPageStrip();
    updatePageIndicator();
    subscribePageData();
  });

  // board meta
  onSnapshot(boardRef, (snap) => {
    const data = snap.data();
    if (!data) return;
    $("#boardTitle").value = data.title || "Untitled Board";
    $("#toggleEditable").checked = !!data.allowEdit;
    $("#allowEdit").checked = !!data.allowEdit;
    updateShareLink();
  });

  // chat
  const chatQ = query(collection(boardRef, "chat"), orderBy("createdAt", "asc"));
  onSnapshot(chatQ, (qsnap) => {
    const list = $("#chatList");
    list.innerHTML = "";
    qsnap.forEach(d => {
      const m = d.data();
      const row = document.createElement("div");
      row.className = "row";
      const name = m.displayName || "User";
      row.textContent = `${name}: ${m.text}`;
      list.appendChild(row);
    });
    list.scrollTop = list.scrollHeight;
  });

  // presence
  const presQ = collection(boardRef, "presence");
  onSnapshot(presQ, (qsnap) => {
    const wrap = $("#presence");
    wrap.innerHTML = "";
    qsnap.forEach(d => {
      const p = d.data();
      const img = document.createElement("img");
      img.className = "avatar";
      if (p.photoURL) img.src = p.photoURL;
      img.title = p.displayName || "Participant";
      wrap.appendChild(img);
    });
  });
}

let unsubStrokes = null;
let unsubObjects = null;
function subscribePageData() {
  if (!currentPageId) return;
  if (unsubStrokes) unsubStrokes();
  if (unsubObjects) unsubObjects();

  const strokesQ = query(
    collection(boardRef, "pages", currentPageId, "strokes"),
    orderBy("createdAt", "asc")
  );
  unsubStrokes = onSnapshot(strokesQ, (qsnap) => {
    strokes = [];
    qsnap.forEach(d => {
      const s = d.data();
      if (!s.deleted) strokes.push({ id: d.id, ...s });
    });
    draw();
    renderLayers();
  });

  const objectsQ = query(
    collection(boardRef, "pages", currentPageId, "objects"),
    orderBy("createdAt", "asc")
  );
  unsubObjects = onSnapshot(objectsQ, (qsnap) => {
    objects = [];
    qsnap.forEach(d => {
      const o = d.data();
      if (!o.deleted) objects.push({ id: d.id, ...o });
    });
    draw();
    renderLayers();
  });
}

// ---- Presence ----
let presTimer = null;
function setupPresence() {
  if (!user) return;
  const pRef = doc(db, "boards", boardId, "presence", user.uid);
  async function tick() {
    await setDoc(pRef, {
      uid: user.uid,
      displayName: user.displayName || "User",
      photoURL: user.photoURL || "",
      lastActive: Date.now()
    }, { merge: true });
  }
  tick();
  presTimer = setInterval(tick, 15000);
}

// ---- UI bindings ----
$("#boardTitle").addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    await updateDoc(boardRef, { title: $("#boardTitle").value });
    e.target.blur();
  }
});

$("#shareBtn").addEventListener("click", () => $("#shareModal").classList.remove("hidden"));
$("#closeShare").addEventListener("click", () => $("#shareModal").classList.add("hidden"));
$("#toggleEditable").addEventListener("change", async (e) => {
  await updateDoc(boardRef, { allowEdit: e.target.checked });
});
$("#copyLink").addEventListener("click", async () => {
  const link = $("#shareLink").value;
  await navigator.clipboard.writeText(link);
  $("#copyLink").textContent = "Copied!";
  setTimeout(() => $("#copyLink").textContent = "Copy", 1200);
});
$("#passcode").addEventListener("change", async (e) => {
  await updateDoc(boardRef, { passcode: e.target.value });
});
function updateShareLink() {
  $("#shareLink").value = `${location.origin}${location.pathname}?${qs({ board: boardId })}`;
}

$(".tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  $$(".tab-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  $$(".tab-content").forEach(c => c.classList.add("hidden"));
  $(`#tab-${btn.dataset.tab}`).classList.remove("hidden");
});

$("#exportMenu").addEventListener("click", () => {
  $("#exportDropdown").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".dropdown")) $("#exportDropdown").classList.add("hidden");
});

// ---- Pages ----
function updatePageIndicator(){
  const idx = pages.findIndex(p => p.id === currentPageId);
  $("#pageIndex").textContent = idx + 1;
  $("#pageCount").textContent = pages.length;
}
function renderPageStrip(){
  const wrap = $("#pageThumbs");
  wrap.innerHTML = "";
  pages.forEach((p, i) => {
    const d = document.createElement("div");
    d.className = "thumb";
    d.textContent = `Page ${i+1}`;
    d.addEventListener("click", () => {
      currentPageId = p.id;
      updatePageIndicator();
      subscribePageData();
    });
    wrap.appendChild(d);
  });
}
async function addPage(){
  const idx = pages.length;
  const ref = await addDoc(collection(boardRef, "pages"), { index: idx, createdAt: serverTimestamp(), bg:"#0A1524" });
  currentPageId = ref.id;
  updatePageIndicator();
  subscribePageData();
}
$("#addPage").addEventListener("click", addPage);
$("#addPage2").addEventListener("click", addPage);
$("#prevPage").addEventListener("click", () => {
  const i = pages.findIndex(p => p.id === currentPageId);
  if (i > 0){ currentPageId = pages[i-1].id; updatePageIndicator(); subscribePageData(); }
});
$("#nextPage").addEventListener("click", () => {
  const i = pages.findIndex(p => p.id === currentPageId);
  if (i < pages.length-1){ currentPageId = pages[i+1].id; updatePageIndicator(); subscribePageData(); }
});

// ---- Tools & Panels ----
const leftbar = document.querySelector(".leftbar");
leftbar.addEventListener("click", (e) => {
  const btn = e.target.closest(".tool-btn");
  if (!btn) return;
  $$(".tool-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  tool = btn.dataset.tool || tool;
  // panels
  $$(".tool-with-panel").forEach(w => w.classList.remove("open"));
  if (tool === "pen") $("#penPanel").parentElement.classList.add("open");
  if (tool === "highlighter") $("#highPanel").parentElement.classList.add("open");
});

document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "v") selectTool("select");
  if (e.key.toLowerCase() === "p") selectTool("pen");
  if (e.key.toLowerCase() === "h") selectTool("highlighter");
  if (e.key.toLowerCase() === "e") selectTool("eraser");
  if (e.key.toLowerCase() === "t") selectTool("text");
  if (e.key.toLowerCase() === "s") selectTool("shapes");
  if (e.key.toLowerCase() === "i") selectTool("image");
  if (e.key.toLowerCase() === "n") selectTool("sticky");
  if (e.key.toLowerCase() === "l") { isLaser = true; }
  if (e.code === "Space") { isPanning = true; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z"){ undo(); }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z"){ redo(); }
});
document.addEventListener("keyup", (e) => {
  if (e.key.toLowerCase() === "l") isLaser = false;
  if (e.code === "Space") isPanning = false;
});
function selectTool(t){
  tool = t;
  $$(".tool-btn").forEach(b => b.classList.toggle("active", b.dataset.tool === t));
  $$(".tool-with-panel").forEach(w => w.classList.remove("open"));
  if (t === "pen") $("#penPanel").parentElement.classList.add("open");
  if (t === "highlighter") $("#highPanel").parentElement.classList.add("open");
}

// ---- Drawing Engine ----
let drawing = false;
let lastPt = null;
let currentStroke = null;

function toCanvasPoint(clientX, clientY){
  const rect = canvas.getBoundingClientRect();
  const x = (clientX - rect.left - offset.x) / zoom;
  const y = (clientY - rect.top - offset.y) / zoom;
  return { x, y };
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (tool === "hand" || isPanning){ drawing = true; lastPt = { x:e.clientX, y:e.clientY }; return; }
  const p = toCanvasPoint(e.clientX, e.clientY);

  if (tool === "pen" || tool === "highlighter"){
    drawing = true;
    const col = tool === "pen" ? $("#penColor").value : $("#highColor").value;
    const size = tool === "pen" ? +$("#penSize").value : +$("#highSize").value;
    const alpha = tool === "pen" ? 1 : +$("#highAlpha").value;
    currentStroke = {
      id: uid(),
      userId: user?.uid || "anon",
      tool, color: col, width: size, alpha,
      points: [p],
      smoothing: $("#penSmooth").checked,
      pressure: $("#penPressure").checked,
      createdAt: Date.now()
    };
  } else if (tool === "text"){
    openTextEditor(p.x, p.y);
  } else if (tool === "eraser"){
    // simple eraser: mark near-by strokes as deleted
    eraseAt(p.x, p.y);
  } else if (tool === "sticky"){
    createObject({ type:"sticky", x:p.x, y:p.y, w:180, h:120, text:"Double-click to edit", color:"#FFD166" });
  } else if (tool === "image"){
    $("#imagePicker").click();
  } else if (tool === "shapes"){
    // simple rectangle starter
    drawing = true;
    currentStroke = { shape:true, type:"rect", id: uid(), userId: user?.uid||"anon", x0:p.x, y0:p.y, x1:p.x, y1:p.y, color:"#22D3EE", width:2, alpha:1, createdAt: Date.now() };
  }
  draw();
});

canvas.addEventListener("pointermove", (e) => {
  const p = toCanvasPoint(e.clientX, e.clientY);

  if (isLaser){
    // show ephemeral laser dot (local only MVP)
    draw(); // redraw to clear previous
    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(zoom, zoom);
    ctx.beginPath();
    ctx.fillStyle = "rgba(255,0,0,0.6)";
    ctx.arc(p.x, p.y, 12, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (tool === "hand" || isPanning){
    if (!drawing) return;
    const dx = e.clientX - lastPt.x;
    const dy = e.clientY - lastPt.y;
    lastPt = { x:e.clientX, y:e.clientY };
    offset.x += dx;
    offset.y += dy;
    draw();
    return;
  }

  if (!drawing) return;

  if (currentStroke?.shape){
    currentStroke.x1 = p.x; currentStroke.y1 = p.y;
    draw(); return;
  }

  if (currentStroke){
    currentStroke.points.push(p);
    draw();
  }
});

canvas.addEventListener("pointerup", async (e) => {
  canvas.releasePointerCapture(e.pointerId);
  if (tool === "hand" || isPanning){ drawing = false; return; }

  if (currentStroke?.shape){
    const s = {
      type:"shape-rect",
      x: Math.min(currentStroke.x0, currentStroke.x1),
      y: Math.min(currentStroke.y0, currentStroke.y1),
      w: Math.abs(currentStroke.x1 - currentStroke.x0),
      h: Math.abs(currentStroke.y1 - currentStroke.y0),
      color: currentStroke.color,
      stroke: currentStroke.width
    };
    await createObject({ type:"shape-rect", ...s });
    currentStroke = null;
    drawing = false; draw(); return;
  }

  if (currentStroke){
    await saveStroke(currentStroke);
    pushUndo({ kind:"stroke", id: currentStroke.id });
    currentStroke = null;
    drawing = false;
  }
  draw();
});

// wheel zoom
canvas.addEventListener("wheel", (e) => {
  if (e.ctrlKey || e.metaKey) e.preventDefault();
  const delta = Math.sign(e.deltaY);
  const factor = delta > 0 ? 0.9 : 1.1;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const before = screenToWorld(px, py);
  zoom = Math.min(6, Math.max(0.2, zoom * factor));
  const after = screenToWorld(px, py);
  offset.x += (before.x - after.x) * zoom;
  offset.y += (before.y - after.y) * zoom;
  updateZoomUI();
  draw();
}, { passive:false });

function screenToWorld(px, py){
  return { x:(px - offset.x)/zoom, y:(py - offset.y)/zoom };
}

$("#fitBtn").addEventListener("click", () => { resetView(); updateZoomUI(); });
$("#zoomIn").addEventListener("click", () => { zoom = Math.min(6, zoom*1.2); updateZoomUI(); draw(); });
$("#zoomOut").addEventListener("click", () => { zoom = Math.max(0.2, zoom/1.2); updateZoomUI(); draw(); });
function updateZoomUI(){ $("#zoomLabel").textContent = Math.round(zoom*100) + "%"; }

// ---- Text Editor ----
function openTextEditor(x, y){
  const rect = canvas.getBoundingClientRect();
  const sx = x*zoom + offset.x + rect.left;
  const sy = y*zoom + offset.y + rect.top;
  textEditor.style.left = sx + "px";
  textEditor.style.top = sy + "px";
  textEditor.textContent = "";
  textEditor.classList.remove("hidden");
  textEditor.focus();

  function commit(){
    const txt = textEditor.textContent.trim();
    textEditor.classList.add("hidden");
    if (txt) createObject({ type:"text", x, y, w:300, h:40, text:txt, color:"#E6F1FF", font:"16px Inter" });
    document.removeEventListener("click", outsideHandler, true);
  }
  function outsideHandler(ev){
    if (!textEditor.contains(ev.target)) commit();
  }
  document.addEventListener("click", outsideHandler, true);
}

// ---- Objects ----
async function createObject(o){
  if (!currentPageId) return;
  const ref = await addDoc(collection(boardRef, "pages", currentPageId, "objects"), {
    ...o, deleted:false, createdAt: serverTimestamp(), userId: user?.uid || "anon"
  });
  pushUndo({ kind:"object", id: ref.id });
}
function renderLayers(){
  const wrap = $("#layerList");
  wrap.innerHTML = "";
  [...strokes.map(s => ({ id:s.id, kind:"stroke" })), ...objects.map(o => ({ id:o.id, kind:"object" }))].slice(-80).forEach((l, i) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span>${l.kind} • ${l.id.slice(-5)}</span>
    <div>
      <button class="icon-btn" data-act="hide" data-kind="${l.kind}" data-id="${l.id}">👁️</button>
      <button class="icon-btn" data-act="del" data-kind="${l.kind}" data-id="${l.id}">🗑️</button>
    </div>`;
    wrap.appendChild(row);
  });

  wrap.onclick = async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const { act, kind, id } = btn.dataset;
    if (act === "del"){
      if (kind === "stroke") await updateDoc(doc(db,"boards",boardId,"pages",currentPageId,"strokes",id), { deleted:true });
      else await updateDoc(doc(db,"boards",boardId,"pages",currentPageId,"objects",id), { deleted:true });
    }
    if (act === "hide"){
      // for MVP, hide == delete
      if (kind === "stroke") await updateDoc(doc(db,"boards",boardId,"pages",currentPageId,"strokes",id), { deleted:true });
      else await updateDoc(doc(db,"boards",boardId,"pages",currentPageId,"objects",id), { deleted:true });
    }
  };
}

// ---- Save stroke ----
async function saveStroke(s){
  if (!currentPageId) return;
  await addDoc(collection(boardRef, "pages", currentPageId, "strokes"), {
    ...s, deleted:false, createdAt: serverTimestamp()
  });
}

// ---- Erase ----
async function eraseAt(x, y){
  // naive: delete last stroke near point
  const hit = [...strokes].reverse().find(s => s.points.some(p => Math.hypot(p.x-x, p.y-y) < 16));
  if (hit){
    await updateDoc(doc(db,"boards",boardId,"pages",currentPageId,"strokes",hit.id), { deleted:true });
    pushUndo({ kind:"stroke-del", id:hit.id, prev:hit });
  }
}

// ---- Draw ----
function draw(){
  // clear
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.save();
  ctx.translate(offset.x, offset.y);
  ctx.scale(zoom, zoom);

  // background
  ctx.fillStyle = "#0A1524";
  ctx.fillRect(0,0,CANVAS_W,CANVAS_H);

  // grid
  if ($("#gridToggle").checked){
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (let x=0; x<CANVAS_W; x+=40){ line(x,0,x,CANVAS_H); }
    for (let y=0; y<CANVAS_H; y+=40){ line(0,y,CANVAS_W,y); }
  }

  // objects behind (shapes)
  for (const o of objects){
    if (o.type === "shape-rect"){
      ctx.strokeStyle = o.color || "#22D3EE";
      ctx.lineWidth = o.stroke || 2;
      ctx.strokeRect(o.x, o.y, o.w, o.h);
    }
  }

  // strokes
  for (const s of strokes){
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = s.width || 4;
    ctx.strokeStyle = s.color || "#22D3EE";
    ctx.globalAlpha = s.alpha ?? 1;
    ctx.beginPath();
    for (let i=0; i<s.points.length; i++){
      const p = s.points[i];
      if (i===0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // current drawing
  if (currentStroke && !currentStroke.shape){
    const s = currentStroke;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = s.width || 4;
    ctx.strokeStyle = s.color || "#22D3EE";
    ctx.globalAlpha = s.alpha ?? 1;
    ctx.beginPath();
    for (let i=0; i<s.points.length; i++){
      const p = s.points[i];
      if (i===0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (currentStroke?.shape){
    const s = currentStroke;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    const x = Math.min(s.x0,s.x1), y = Math.min(s.y0,s.y1);
    const w = Math.abs(s.x1-s.x0), h = Math.abs(s.y1-s.y0);
    ctx.strokeRect(x,y,w,h);
  }

  // objects front (text, sticky)
  for (const o of objects){
    if (o.type === "text"){
      ctx.fillStyle = o.color || "#E6F1FF";
      ctx.font = o.font || "16px Inter";
      ctx.fillText(o.text, o.x, o.y);
    }
    if (o.type === "sticky"){
      ctx.fillStyle = o.color || "#FFD166";
      roundRect(ctx, o.x, o.y, o.w, o.h, 8);
      ctx.fillStyle = "#111";
      ctx.font = "14px Inter";
      wrapText(ctx, o.text || "", o.x+10, o.y+24, o.w-20, 18);
    }
  }

  ctx.restore();
}
function line(x1,y1,x2,y2){ ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); }
function roundRect(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
  ctx.fill();
}
function wrapText(ctx, text, x, y, maxWidth, lineHeight){
  const words = text.split(" ");
  let line = "";
  for (let n=0; n<words.length; n++){
    const testLine = line + words[n] + " ";
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && n>0){
      ctx.fillText(line, x, y);
      line = words[n] + " ";
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
 
