// static/js/app.js

const BASE = ""; // set to "" if running on localhost
const APP_MODE = "draw"; // "draw" or "landmark"
const IS_DRAW = APP_MODE === "draw";
const IS_LANDMARK = APP_MODE === "landmark";
// const BASE = "http://windoek.sp.cs.cmu.edu:8000"; // set to your server URL
const STORAGE_KEY = "drawSiteState";
const AUTOSAVE_INTERVAL_MS = 10000;
const UNDO_LIMIT = 10;
const MAX_QUIZ_ATTEMPTS = 5;
const PROLIFIC_SCREENOUT_URL = "https://app.prolific.com/submissions/complete?cc=C170KQM0"

/* ---------------- In-memory state ---------------- */
let batch = [], savedAns = {};
let taskMetrics = {};
let autoSaveTimer = null;

let state = {
  currentPage: "instr-page",
  batch: [],
  savedAns: {},
  tIdx: 0,

  // VIDEO STATE
  videoState: {
    // task_id -> { currentTime, paused }
  },

  prolific: {
    initialized: false  
  },

  quiz: {
    attempts: 0,
    passed: false,
    screened_out: false
  },

  drawings: {},        // map task_id -> base64 image (finalized)
  drawing_paths: {},
  landmarks: {},        // map task_id -> array of strings
  metricsByTask: {},   // <-- ADD
  textBoxesByTask: {}, 
  markersByTask: {},
};

// Restore from localStorage
function normalizeState() {
  state.prolific = state.prolific || { initialized: false };
  state.quiz = state.quiz || { attempts: 0, passed: false, screened_out: false };
  state.videoState = state.videoState || {};
  state.metricsByTask = state.metricsByTask || {};   // <-- ADD
  state.drawings = state.drawings || {};
  state.drawing_paths = state.drawing_paths || {};
  state.landmarks = state.landmarks || {};
  state.batch = state.batch || [];
  state.savedAns = state.savedAns || {};
  state.textBoxesByTask = state.textBoxesByTask || {};
  state.markersByTask = state.markersByTask || {};
  if (typeof state.tIdx !== "number") state.tIdx = 0;
  if (!state.currentPage) state.currentPage = "instr-page";
  if (state.currentPage === "landmark-page") state.currentPage = "task-page";
}

// ------------------ Restore State ------------------
document.addEventListener("DOMContentLoaded", async () => {
  console.log("DOM fully loaded and parsed, restoring state...");
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    console.log("Restored state:", saved);
    if (saved) Object.assign(state, saved);
    normalizeState();
  } catch (e) {
    console.warn("Could not parse saved state:", e);
  }

  // ---- then merge Prolific params into state ----
  await hydrateProlificFromServer();

  if (!state.prolific?.pid) {
    console.log("URL query parameters:", getQueryParams());
    alert("Missing Prolific ID. Please return to Prolific and relaunch the study.");
    // Optional: stop here
    return;
  }

  // Force start page on fresh Prolific entry
  if (state._justEnteredFromProlific) {
    console.log("Fresh Prolific entry → redirecting to instruction page");
    state.currentPage = "instr-page";
    delete state._justEnteredFromProlific; // one-time only
    saveState();
  }

  // Show whatever page we were on last
  show(state.currentPage);
  setupQuizMapZoom();

  // Reattach batch / savedAns from state if present
  if (Array.isArray(state.batch) && state.batch.length > 0) {
    batch = state.batch;
    savedAns = state.savedAns || {};
  }

  console.log("Current page:", state.currentPage);
  console.log("State before restoration/initial load:", state);

  if (state.currentPage === "task-page") {
    if (!Array.isArray(batch) || batch.length === 0) {
      console.log("No batch loaded, fetching next batch...");
      await fetchBatch();
      batch = state.batch;
      savedAns = state.savedAns || {};
    }
    renderTask();
    const t = batch[state.tIdx];
    if (t && t.task_id) {
      if (IS_DRAW) startTaskTimer(t.task_id);
      if (IS_LANDMARK) startLandmarkTimer(t.task_id);
    }
    startAutoSave();
  }

  console.log("State after restoration/initial load:", state);
});

function setupQuizMapZoom() {
  const img = document.getElementById("quiz-map-img");
  if (!img) return;

  const updateOrigin = (e) => {
    const rect = img.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    img.style.transformOrigin = `${x}% ${y}%`;
  };

  img.addEventListener("mouseenter", () => img.classList.add("zoomed"));
  img.addEventListener("mouseleave", () => {
    img.classList.remove("zoomed");
    img.style.transformOrigin = "50% 50%";
  });
  img.addEventListener("mousemove", updateOrigin);
}

// ------------------ Clear Local State (Dev only) + Dev Shortcuts ------------------
document.addEventListener("keydown", async e => {
  // Dev: clear local state (Ctrl + R)
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "r") {
    localStorage.removeItem(STORAGE_KEY);
    state = {
      currentPage: "instr-page",
      batch: [],
      savedAns: {},
      tIdx: 0,
      obsIdxPerTask: {}, // map task_id -> obs idx
      drawings: {},      // map task_id -> base64 image (finalized)
      drawing_paths: {},
      landmarks: {},      // map task_id -> array of strings
      textBoxesByTask: {},
      markersByTask: {},
    };
    alert("Local state cleared");
    return;
  }

  // Dev: skip screening quiz (Ctrl + Shift + S) when on quiz page
  if (
    e.ctrlKey &&
    e.shiftKey &&
    e.key.toLowerCase() === "s" &&
    state.currentPage === "quiz-page"
  ) {
    e.preventDefault();
    await devSkipQuiz();
  }
});

// ------------------ Save State ------------------
function saveState() {
  console.log("Saving state to localStorage:", state);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ------------------ Prolific ------------------
function getQueryParams() {
  const params = {};
  const search = window.location.search.substring(1);
  for (const part of search.split("&")) {
    if (!part) continue;
    const [key, val] = part.split("=");
    params[decodeURIComponent(key)] = decodeURIComponent(val || "");
  }
  return params;
}

async function hydrateProlificFromServer() {
  try {
    const res = await fetch("/api/whoami", { credentials: "same-origin" });
    if (!res.ok) return;
    const me = await res.json();

    state.prolific = state.prolific || {};

    if (me.prolific_pid) state.prolific.pid = me.prolific_pid;
    if (me.prolific_study_id) state.prolific.study_id = me.prolific_study_id;
    if (me.prolific_session_id) state.prolific.session_id = me.prolific_session_id;

    // 👇 mark first successful hydrate
    if (!state.prolific.initialized && me.prolific_pid) {
      state.prolific.initialized = true;
      state._justEnteredFromProlific = true; // transient flag
    }

    saveState();
  } catch (e) {
    console.warn("Could not hydrate prolific from server:", e);
  }
}

// ------------------ Show Page ------------------
function show(pageId) {
  ["instr-page", "quiz-page", "task-page", "done-page", "screenout-page"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove("active");
  });
  const pageEl = document.getElementById(pageId);
  if (pageEl) pageEl.classList.add("active");

  state.currentPage = pageId;
  saveState();

  if (pageId === "task-page") {
    requestAnimationFrame(() => {
      const t = batch?.[state.tIdx];
      if (t && t.task_id) {
        loadDrawingForTask(t.task_id);
        restoreTextBoxesForTask(t.task_id);
        restoreMarkersForTask(t.task_id);
      } else if (canvas && ctx) {
        resizeCanvasToDisplay();
        setCanvasBackground();
      }
    });
  }
}

// ------------------ Render Quiz ------------------
// Example landmarks
const exampleLandmarks = [
  "Start (S)",
  "First intersection with crosswalks",
  "Second intersection with crosswalks",
  "Point B",
  "Third intersection with cross walks",
  "Pass through fourth intersection with cross walks",
  "Turn onto alleyway",
  "Parking spots on either side of the street",
  "Point C",
  "Tall brick buildings on either side",
  "Pass through fifth intersection with crosswalks",
  "Turn onto Public Alley",
  "Parking spots on either side of the street",
  "Point A",
  "Turn out of alleyway",
  "Pass through sixth intersection with crosswalks",
  "Pass seventh intersection with crosswalks",
  "Park with grass and trees on either side of the street",
  "Turn at eighth intersection with crosswalks",
  "End (G)"
];
const movableQuizItems = [
  "Start (S)",
  "Point A",
  "Point B",
  "Point C",
  "End (G)"
];
const movableQuizSet = new Set(movableQuizItems);

function createBankItem(text) {
  const li = document.createElement("li");
  li.textContent = text;
  li.className = "quiz-draggable";
  li.draggable = true;
  li.dataset.value = text;
  return li;
}

function clearSlot(slot) {
  slot.dataset.value = "";
  slot.textContent = "Drop here";
  slot.classList.remove("filled");
}
// Render shuffled landmarks into quiz list
function renderQuizLandmarks() {
  const fixedList = document.getElementById("quiz-fixed-list");
  const bankList = document.getElementById("quiz-draggable-list");
  if (!fixedList || !bankList) return;

  fixedList.innerHTML = "";
  bankList.innerHTML = "";

  exampleLandmarks.forEach(text => {
    const li = document.createElement("li");
    if (movableQuizSet.has(text)) {
      li.className = "quiz-slot";
      li.dataset.placeholder = text;
      li.draggable = false;
      clearSlot(li);
    } else {
      li.className = "quiz-fixed-item";
      li.textContent = text;
      li.draggable = false;
    }
    fixedList.appendChild(li);
  });

  movableQuizItems.forEach(text => {
    bankList.appendChild(createBankItem(text));
  });
}
renderQuizLandmarks();

// Drag & drop behavior
let draggedValue = null;
let draggedEl = null;

document.addEventListener("dragstart", e => {
  const item = e.target.closest(".quiz-draggable");
  if (!item) return;
  draggedEl = item;
  draggedValue = item.dataset.value || item.textContent;
  item.style.opacity = "0.5";
  e.dataTransfer.setData("text/plain", draggedValue);
});

document.addEventListener("dragend", e => {
  if (draggedEl) draggedEl.style.opacity = "";
  draggedEl = null;
  draggedValue = null;
});

document.addEventListener("dragover", e => {
  const slot = e.target.closest(".quiz-slot");
  const bank = e.target.closest("#quiz-draggable-list");
  if (slot || bank) e.preventDefault();
});

document.addEventListener("drop", e => {
  const slot = e.target.closest(".quiz-slot");
  const bank = e.target.closest("#quiz-draggable-list");
  if (!draggedValue) return;

  if (slot) {
    e.preventDefault();
    if (slot.dataset.value) {
      bank?.appendChild(createBankItem(slot.dataset.value));
    }
    slot.dataset.value = draggedValue;
    slot.textContent = draggedValue;
    slot.classList.add("filled");
    if (draggedEl) draggedEl.remove();
  } else if (bank) {
    e.preventDefault();
  }
});

document.addEventListener("click", e => {
  const slot = e.target.closest(".quiz-slot");
  const bank = document.getElementById("quiz-draggable-list");
  if (!slot || !bank) return;
  if (slot.dataset.value) {
    bank.appendChild(createBankItem(slot.dataset.value));
    clearSlot(slot);
  }
});

document.getElementById("submit-quiz-btn").onclick = async () => {
  const quizList = document.querySelectorAll("#quiz-fixed-list li");
  const order = Array.from(quizList).map(li => {
    if (li.classList.contains("quiz-slot")) {
      return li.dataset.value || "";
    }
    return li.textContent;
  });

  if (order.includes("")) {
    alert("Please place all five labels before submitting.");
    return;
  }

  try {
    const res = await fetch("/check_quiz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order })
    });

    const data = await res.json();

    if (data.correct) {
      // ✅ Passed
      state.quiz.passed = true;
      saveState();

      await fetchBatch();
      renderTask();
      show("task-page");
      startAutoSave();
      return;
    }

    // ❌ Failed attempt
    state.quiz.attempts = (state.quiz.attempts || 0) + 1;
    saveState();

    const remaining = MAX_QUIZ_ATTEMPTS - state.quiz.attempts;

    if (remaining <= 0) {
      // Too many failures → screen out + redirect
      screenOutParticipant("failed_quiz");
    } else {
      alert(`That order is not correct. Please try again. (${remaining} attempt(s) left)`);
    }

  } catch (err) {
    console.error("Quiz check failed:", err);
    alert("Sorry, something went wrong checking your answer.");
  }
};

function screenOutParticipant(reason = "failed_quiz") {
  state.quiz.screened_out = true;
  state.quiz.screenout_reason = reason;
  saveState();

  // Show a friendly page for ~0.5s (optional), then redirect
  show("screenout-page");

  // setTimeout(() => {
  //   window.location.href = PROLIFIC_SCREENOUT_URL;
  // }, 500);
}

// ------------------ Fetch Batch ------------------
async function fetchBatch() {
  try {
    const res = await fetch(BASE + "/next_batch");
    console.log("Fetched batch from:", BASE + "/next_batch");

    const data = await res.json();
    batch = data.trajectories || [];
    savedAns = data.saved_answers || {};
    state.batch = batch;
    state.savedAns = savedAns;
    state.tIdx = 0;
    saveState();

    // If backend returns saved drawings per-task inside saved_answers,
    // populate state.drawings here. Example: saved_answers[task_id].drawing
    for (const tid in savedAns) {
      if (savedAns[tid] && savedAns[tid].drawing) {
        state.drawings[tid] = savedAns[tid].drawing; // base64 image expected
      }
      if (savedAns[tid] && savedAns[tid].drawing_url) {
        state.drawing_paths[tid] = savedAns[tid].drawing_url;
      }
      if (savedAns[tid] && Array.isArray(savedAns[tid].landmarks)) {
        state.landmarks[tid] = savedAns[tid].landmarks;
      }
    }

    return data;
  } catch (err) {
    console.error("fetchBatch failed", err);
    throw err;
  }
}

// ------------------ DEV: Skip Quiz Shortcut ------------------
async function devSkipQuiz() {
  console.log("[DEV] Skipping quiz via keyboard shortcut");

  try {
    // Ensure we have a batch
    if (!Array.isArray(batch) || batch.length === 0) {
      await fetchBatch();
    } else {
      // Make sure our globals line up with state
      batch = state.batch || batch;
      savedAns = state.savedAns || savedAns;
    }

    // Go straight to task page
    renderTask();
    show("task-page");
    startAutoSave();
  } catch (err) {
    console.error("[DEV] Failed to skip quiz:", err);
    alert("Dev skip failed: could not load tasks.");
  }
}

document.getElementById("begin-btn").onclick = async () => {
  // If quiz is enabled and not passed, go to quiz
  if (!state.quiz?.passed) {
    show("quiz-page");
    return;
  }

  // Otherwise go straight to tasks
  try {
    await fetchBatch();
    renderTask();
    show("task-page");
    startAutoSave();
  } catch (err) {
    console.error("Could not begin tasks:", err);
    alert("Sorry, could not load the tasks. Please try again.");
  }
};

// ------------------ Display Insructions ------------------
document.addEventListener("DOMContentLoaded", () => {
  const template = document.getElementById("instructions-template");

  // Clone into intro page
  document.getElementById("instr-content").appendChild(template.content.cloneNode(true));

  // Clone into modal
  document.getElementById("modal-instr-content").appendChild(template.content.cloneNode(true));
});

// ------------------ Show Instructions Modal ------------------
const instructionsDiv = document.getElementById("instructions-modal");
const toggleBtn = document.getElementById('show-instructions-btn');

toggleBtn.onclick = () => {
  const isHidden = instructionsDiv.style.display === "none" || instructionsDiv.style.display === "";
  
  if (isHidden) {
    instructionsDiv.style.display = "block";
    toggleBtn.textContent = "Hide Instructions"; // optional: change button text
  } else {
    instructionsDiv.style.display = "none";
    toggleBtn.textContent = "Show Instructions";
  }
};


// ------------------ Render Task ------------------
// Drawing undo/redo stacks per task (in-memory)
const undoStacks = {}; // task_id -> [ImageData]
const redoStacks = {}; // task_id -> [ImageData]

// ------------------ Metrics Per Task ------------------
function ensureMetricsStore() {
  state.metricsByTask = state.metricsByTask || {}; // task_id -> metrics object
}

function initTaskMetricsFor(taskId) {
  ensureMetricsStore();
  if (!state.metricsByTask[taskId]) {
    const now = performance.now();
    state.metricsByTask[taskId] = {
      timing: {
        pageEnterMs: now,
        firstInteractionMs: null,
        drawingDurationMs: null,
        landmarkEnterMs: null,
        landmarkDurationMs: null
      },
      video: {
        playCount: 0,
        pauseCount: 0,
        seekCount: 0,
        totalWatchTimeMs: 0,
        lastPlayStartedMs: null,
        maxWatchedTime: 0
      },
      interactions: {
        clickedGoToLandmarksMs: null,
        clickedSaveNextMs: null,
        addLandmark: 0,
        deleteLandmark: 0,
        reorderLandmark: 0,
        undo: 0,
        redo: 0
      },
      drawing: {
        strokeCount: 0,
        firstStrokeMs: null,
        lastStrokeMs: null,
        // store a capped list of points for entropy
        points: [] // [{x, y}] in canvas coords
      }
    };
    saveState();
  }
  return state.metricsByTask[taskId];
}

function getTaskMetrics(taskId) {
  return initTaskMetricsFor(taskId);
}

function recordFirstInteraction(taskId) {
  const m = getTaskMetrics(taskId);
  if (m.timing.firstInteractionMs == null) {
    m.timing.firstInteractionMs = performance.now();
    saveState();
  }
}

function finalizeWatchIfPlaying(taskId) {
  const m = getTaskMetrics(taskId);
  if (m.video.lastPlayStartedMs != null) {
    m.video.totalWatchTimeMs += performance.now() - m.video.lastPlayStartedMs;
    m.video.lastPlayStartedMs = null;
    saveState();
  }
}

function renderTask(){
  if (!Array.isArray(batch) || batch.length === 0) {
    console.warn("renderTask called too early—batch not loaded");
    return;
  }

  const t = batch[state.tIdx];
  if (!t) return;

  // Ensure per-task metrics exist (DO NOT overwrite)
  getTaskMetrics(t.task_id);

  // Map
  document.getElementById("map-img").src = BASE + t.map_url;
  console.log("Map loaded from:", BASE + t.map_url);

  // Video
  console.log("Loading video for task:", t.task_id);
  renderObsVideo(t);

  // Drawing pad (draw app only)
  if (IS_DRAW) {
    initCanvas(t);
  }

  if (IS_LANDMARK) {
    if (!state.landmarks[t.task_id] || state.landmarks[t.task_id].length === 0) {
      state.landmarks[t.task_id] = [...t.landmarks];
    }
    renderLandmarksUI(t);

    const savedImgEl = document.getElementById("saved-drawing-img");
    if (savedImgEl) {
      savedImgEl.src = BASE + (state.drawing_paths[t.task_id] || "");
    }
  }

  // Buttons
  updateSaveButtons();
}

function updateRouteIndicator() {
  const el = document.getElementById("route-indicator");
  if (!el || !batch || batch.length === 0) return;
  el.textContent = `Route ${state.tIdx + 1} of ${batch.length}`;
}

// ------------------ Render Observations ------------------
function renderObsVideo(t) {
  const video = document.getElementById("obs-video");
  const source = document.getElementById("obs-video-src");
  const url = BASE + "/videos/" + t.video;

  video.controls = true;
  video.preload = "metadata";

  state.videoState = state.videoState || {};
  ensureMetricsStore();

  const curSrc = source.getAttribute("src") || source.src || "";

  // If switching away from a previous task while playing, finalize watch time
  const prevTaskId = video.getAttribute("data-task-id");
  if (prevTaskId && prevTaskId !== t.task_id) {
    finalizeWatchIfPlaying(prevTaskId);

    state.videoState[prevTaskId] = state.videoState[prevTaskId] || { currentTime: 0, paused: true };
    state.videoState[prevTaskId].currentTime = video.currentTime || 0;
    state.videoState[prevTaskId].paused = video.paused;
    saveState();
  }

  // If same video already loaded, ensure handlers and restore state
  if (curSrc === url) {
    attachVideoStateHandlers(video, t.task_id);
    return;
  }

  // Switch source
  video.setAttribute("data-task-id", t.task_id);
  source.setAttribute("src", url);
  video.load();

  attachVideoStateHandlers(video, t.task_id);

  // Restore time once metadata is ready
  const saved = state.videoState[t.task_id];
  video.onloadedmetadata = () => {
    if (saved && saved.currentTime != null) {
      const desired = saved.currentTime || 0;
      const maxT = isFinite(video.duration) ? Math.max(0, video.duration - 0.25) : desired;
      video.currentTime = Math.min(desired, maxT);

      if (saved.paused === false) {
        video.play().catch(() => {});
      }
    }
  };

  saveState();
}

function attachVideoStateHandlers(video, taskId) {
  // Avoid stacking handlers
  if (video._videoStateHandlersFor === taskId) return;
  video._videoStateHandlersFor = taskId;

  state.videoState = state.videoState || {};
  state.videoState[taskId] = state.videoState[taskId] || { currentTime: 0, paused: true };

  const m = getTaskMetrics(taskId);

  let lastSavedAtMs = 0;
  const SAVE_EVERY_MS = 750;

  const saveNow = () => {
    state.videoState[taskId].currentTime = video.currentTime || 0;
    state.videoState[taskId].paused = video.paused;
    saveState();
  };

  video.ontimeupdate = () => {
    const now = performance.now();
    m.video.maxWatchedTime = Math.max(m.video.maxWatchedTime, video.currentTime || 0);

    if (now - lastSavedAtMs >= SAVE_EVERY_MS) {
      lastSavedAtMs = now;
      saveNow();
    }
  };

  video.onplay = () => {
    recordFirstInteraction(taskId);
    m.video.playCount += 1;
    m.video.lastPlayStartedMs = performance.now();
    state.videoState[taskId].paused = false;
    saveState();
  };

  video.onpause = () => {
    m.video.pauseCount += 1;
    finalizeWatchIfPlaying(taskId);
    state.videoState[taskId].paused = true;
    saveNow();
  };

  video.onseeked = () => {
    m.video.seekCount += 1;
    recordFirstInteraction(taskId);
    saveState();
  };

  video.onended = () => {
    finalizeWatchIfPlaying(taskId);
    state.videoState[taskId].currentTime = 0;
    state.videoState[taskId].paused = true;
    saveState();
  };
}

// ------------------ Map Zoom on Click ------------------
window.addEventListener("DOMContentLoaded", () => {
  const openMapBtn = document.getElementById("open-map-btn");
  const mapModal   = document.getElementById("map-modal");
  const img        = document.getElementById("map-img");
  const hideBtn    = document.getElementById("map-hide-btn");

  if (!openMapBtn || !mapModal || !img || !hideBtn) return;

  const ZOOM = 2;            // <-- smaller zoom; try 1.25–1.6
  const DRAG_THRESHOLD_PX = 6;  // <-- 5–10

  let scale = 1;
  let tx = 0, ty = 0;
  let isDragging = false;
  let moved = false;
  let startX = 0, startY = 0;
  let startTx = 0, startTy = 0;

  // Make sure the image is pannable when transformed
  img.style.transformOrigin = "center center";
  img.style.cursor = "zoom-in";

  function applyTransform() {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  function isOpen() {
    return mapModal.classList.contains("visible");
  }

  function isZoomed() {
    return mapModal.classList.contains("zoomed");
  }

  function clampPan() {
    // Clamp based on the scaled image size vs modal size.
    // Use natural size * scale (more stable than getBoundingClientRect during transforms)
    const vw = mapModal.clientWidth;
    const vh = mapModal.clientHeight;

    const naturalW = img.naturalWidth || vw;
    const naturalH = img.naturalHeight || vh;

    // Fit image "contain" into modal (approx)
    const fitScale = Math.min(vw / naturalW, vh / naturalH);
    const displayedW = naturalW * fitScale * scale;
    const displayedH = naturalH * fitScale * scale;

    const extraX = Math.max(0, (displayedW - vw) / 2);
    const extraY = Math.max(0, (displayedH - vh) / 2);

    tx = Math.max(-extraX, Math.min(extraX, tx));
    ty = Math.max(-extraY, Math.min(extraY, ty));
  }

  function setZoom(on) {
    mapModal.classList.toggle("zoomed", on);
    scale = on ? ZOOM : 1;
    if (!on) { tx = 0; ty = 0; }
    img.style.cursor = on ? "grab" : "zoom-in";
    applyTransform();
    requestAnimationFrame(() => { clampPan(); applyTransform(); });
  }

  // ---------- OPEN / CLOSE MODAL ----------
  openMapBtn.addEventListener("click", () => {
    mapModal.classList.add("visible");
    setZoom(false);          // reset when opening
    moved = false;
  });

  hideBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    mapModal.classList.remove("visible");
    setZoom(false);
    moved = false;
  });

  // Optional: click dark backdrop closes (but NOT when clicking image)
  mapModal.addEventListener("click", (e) => {
    if (e.target === mapModal) {
      mapModal.classList.remove("visible");
      setZoom(false);
      moved = false;
    }
  });

  // ---------- CLICK TO TOGGLE ZOOM (but suppress after drag) ----------
  img.addEventListener("click", (e) => {
    if (!isOpen()) return;

    if (moved) {
      // this click was actually a drag-release click
      e.preventDefault();
      e.stopPropagation();
      moved = false;
      return;
    }
    setZoom(!isZoomed());
  });

  // ---------- PAN (mouse) ----------
  img.addEventListener("mousedown", (e) => {
    if (!isOpen() || !isZoomed()) return;
    isDragging = true;
    moved = false;

    startX = e.clientX; startY = e.clientY;
    startTx = tx; startTy = ty;

    img.style.cursor = "grabbing";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!moved && (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX)) {
      moved = true;
    }

    tx = startTx + dx;
    ty = startTy + dy;
    clampPan();
    applyTransform();
  });

  window.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    if (isZoomed()) img.style.cursor = "grab";
    // leave `moved` true; the subsequent click handler will clear it
  });

  // ---------- PAN (touch) ----------
  img.addEventListener("touchstart", (e) => {
    if (!isOpen() || !isZoomed()) return;
    if (e.touches.length !== 1) return;

    isDragging = true;
    moved = false;

    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startTx = tx; startTy = ty;
  }, { passive: true });

  img.addEventListener("touchmove", (e) => {
    if (!isDragging) return;
    if (e.touches.length !== 1) return;

    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;

    if (!moved && (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX)) {
      moved = true;
    }

    tx = startTx + dx;
    ty = startTy + dy;
    clampPan();
    applyTransform();

    // prevent the page from scrolling while panning the image
    e.preventDefault();
  }, { passive: false });

  img.addEventListener("touchend", () => {
    isDragging = false;
    // moved will be cleared by the click handler on tap; for touch, this is fine.
  });
});

// ------------------ Landmarks UI ------------------

// Default scaffold used when a task has no saved landmarks yet
const DEFAULT_LANDMARK_SCAFFOLD = [
  "Start (S)",
  "Point A",
  "Point B",
  "Point C",
  "End (G)"  
];

function renderLandmarksUI(t) {
  const lmList = document.getElementById("landmark-list");
  lmList.innerHTML = "";
  const taskMetrics = getTaskMetrics(t.task_id);

  // If we've already edited this task before, use what's in state.
  // Otherwise, start from the default scaffold.
  let taskLandmarks = state.landmarks[t.task_id];

  if (!taskLandmarks || !taskLandmarks.length) {
    // First time on this task → use default scaffold
    taskLandmarks = [...DEFAULT_LANDMARK_SCAFFOLD];
  }

  state.landmarks[t.task_id] = taskLandmarks;

  taskLandmarks.forEach((lm, idx) => {
    const li = document.createElement("li");
    li.className = "lm-item";
    li.draggable = true;
    li.dataset.idx = idx;  // <-- needed for drag/drop to work

    const input = document.createElement("input");
    input.type = "text";
    input.value = lm;
    input.oninput = () => {
      taskLandmarks[idx] = input.value;
      saveState();
    };

    const delBtn = document.createElement("button");
    delBtn.className = "lm-del";
    delBtn.textContent = "x";
    delBtn.onclick = () => {
      taskLandmarks.splice(idx, 1);
      renderLandmarksUI(t);
      taskMetrics.interactions.deleteLandmark += 1;
      saveState();
    };

    li.appendChild(input);
    li.appendChild(delBtn);
    lmList.appendChild(li);
  });

  // Add button
  const addBtn = document.createElement("button");
  addBtn.textContent = "+ Add Landmark";
  addBtn.onclick = () => {
    taskLandmarks.push("");
    renderLandmarksUI(t);
    taskMetrics.interactions.addLandmark += 1;
    saveState();
  };
  lmList.appendChild(addBtn);

  // drag-and-drop reorder (native)
  let dragSrcIdx = null;
  lmList.querySelectorAll(".lm-item").forEach(li => {
    li.addEventListener("dragstart", (e) => {
      dragSrcIdx = Number(li.dataset.idx);
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      dragSrcIdx = null;
    });
    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      const targetIdx = Number(li.dataset.idx);
      if (dragSrcIdx !== null && dragSrcIdx !== targetIdx) {
        const arr = state.landmarks[t.task_id];
        const [moved] = arr.splice(dragSrcIdx, 1);
        arr.splice(targetIdx, 0, moved);
        renderLandmarksUI(t);
        taskMetrics.interactions.reorderLandmark += 1;
        saveState();
      }
    });
  });
}

// Read the current landmarks from the DOM and sync into state.landmarks
function getCurrentTaskLandmarks(t) {
  // All editable landmark rows
  const inputs = document.querySelectorAll("#landmark-list .lm-item input");

  // If we for some reason don't find any inputs (e.g. DOM not rendered),
  // fall back to whatever is in state.
  if (!inputs.length) {
    return state.landmarks[t.task_id] || [];
  }

  const landmarks = Array.from(inputs)
    .map(inp => inp.value.trim())
    .filter(text => text.length > 0); // ignore completely empty rows

  state.landmarks[t.task_id] = landmarks;
  saveState();
  return landmarks;
}

// ------------------ Drawing Pad ------------------
/* Required HTML elements (IDs/classes) expected:
   - <canvas id="draw-canvas">
   - tool buttons: .tool (id values: "brush","eraser","rectangle","circle","triangle")
   - #fill-color (checkbox)
   - #size-slider (range)
   - .colors .option (color swatches)
   - #color-picker (input type=color)
   - .clear-canvas (button)
   - .save-img (button)
   - .undo-btn, .redo-btn (buttons)
   - .eraser-btn maybe redundant if you have .tool id=eraser
   Make sure those exist in your HTML. */

const canvas = document.getElementById("canvas");
const toolBtns = document.querySelectorAll(".tool");
const fillColor = document.querySelector("#fill-color");
const sizeSlider = document.querySelector("#size-slider");
const colorBtns = document.querySelectorAll(".colors .option");
const colorPicker = document.querySelector("#color-picker");
const markerBtns = document.querySelectorAll(".marker-btn");
const clearCanvasBtn = document.querySelector(".clear-canvas");
const saveImgBtn = document.querySelector(".save-img");
const undoBtn = document.getElementById("undo-btn");
const redoBtn = document.getElementById("redo-btn");
const ctx = canvas ? canvas.getContext("2d") : null;

let prevMouseX = 0, prevMouseY = 0, snapshot = null;
let isDrawing = false, hasDrawn = false;
let selectedTool = "brush";

// base size from slider
let baseWidth = 5;
let brushWidth = 5;
let eraserWidth = 15;  // will be kept in sync with baseWidth

let selectedColor = "#000";
let drawingBoard = null;
let selectedMarker = null;

/* Helper to check if canvas is empty */
function isCanvasBlank(c) {
  console.log("Checking if canvas is blank");
  if (!c.width || !c.height) return true;
  if (document.querySelector(".text-box, .marker-stamp")) return false;
  const ctx = c.getContext('2d');
  const pixelBuf = new Uint32Array(
    ctx.getImageData(0, 0, c.width, c.height).data.buffer
  );
  return !pixelBuf.some(color => color !== 4294967295);
}

function getCanvasCssSize() {
  const r = canvas.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

/* Resize canvas to CSS size */
// Display canvas uses true screen size (no drift)
function resizeCanvasToDisplay() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (!rect.width || !rect.height) return;

  // Match internal buffer to what the user actually sees
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);

  // Draw in CSS pixel units (so mouse math is simple)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Mouse position in CSS pixels (matches ctx after setTransform)
function getMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left),
    y: (e.clientY - rect.top)
  };
}

function ensureCanvasReady() {
  if (!canvas || !ctx) return false;
  if (!canvas.width || !canvas.height) {
    resizeCanvasToDisplay();
    if (!canvas.width || !canvas.height) return false;
    setCanvasBackground();
  }
  return true;
}

/* Background */
const setCanvasBackground = () => {
  const { w, h } = getCanvasCssSize();
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = selectedColor;
};

/* Snapshots for shapes (store image data before starting shape) */
const takeSnapshot = () => snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);

/* push current canvas to undo stack for this task */
function pushUndo(task_id) {
  if (!undoStacks[task_id]) undoStacks[task_id] = [];
  // snapshot current canvas
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  undoStacks[task_id].push(data);
  if (undoStacks[task_id].length > UNDO_LIMIT) undoStacks[task_id].shift();
  // clearing redo stack on new action
  redoStacks[task_id] = [];
  
}

/* commit the current canvas to state.drawings as base64 */
function commitDrawingSnapshotToState(task_id) {
  if (!isCanvasBlank(canvas)) {
    state.drawings[task_id] = canvas.toDataURL("image/png");
  }
  saveState();
}

function commitCurrentDrawing(taskId) {
  if (!taskId) return;

  // 1) persist DOM → state
  saveTextBoxesForTask(taskId);
  saveMarkersForTask(taskId);

  // 2) snapshot canvas pixels (no flatten)
  commitDrawingSnapshotToState(taskId);

  // 3) (optional) keep UI consistent if anything re-rendered
  // restoreTextBoxesForTask(taskId);
}

/* Undo / Redo handlers */
function doUndo(task_id) {
  const ustack = undoStacks[task_id] || [];
  if (ustack.length === 0) return;
  const taskMetrics = getTaskMetrics(task_id);
  const last = ustack.pop();
  // push current to redo
  if (!redoStacks[task_id]) redoStacks[task_id] = [];
  redoStacks[task_id].push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  // restore last
  ctx.putImageData(last, 0, 0);
  commitDrawingSnapshotToState(task_id);
  taskMetrics.interactions.undo += 1;
}

function doRedo(task_id) {
  const rstack = redoStacks[task_id] || [];
  if (rstack.length === 0) return;
  const taskMetrics = getTaskMetrics(task_id);
  const next = rstack.pop();
  // push current to undo
  if (!undoStacks[task_id]) undoStacks[task_id] = [];
  undoStacks[task_id].push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  ctx.putImageData(next, 0, 0);
  commitDrawingSnapshotToState(task_id);
  taskMetrics.interactions.redo += 1;
}

/* Primitive shape drawing helpers */
const drawRect = (pos) => {
  const w = prevMouseX - pos.x, h = prevMouseY - pos.y;
  if (!fillColor.checked) ctx.strokeRect(pos.x, pos.y, w, h);
  else ctx.fillRect(pos.x, pos.y, w, h);
};

const drawLine = (pos) => {
  ctx.beginPath();
  ctx.moveTo(prevMouseX, prevMouseY); // start point
  ctx.lineTo(pos.x, pos.y);   // end point
  ctx.stroke();                       // draw line
};

const drawCircle = (pos) => {
  ctx.beginPath();
  const radius = Math.sqrt(Math.pow((prevMouseX - pos.x), 2) + Math.pow((prevMouseY - pos.y), 2));
  ctx.arc(prevMouseX, prevMouseY, radius, 0, 2 * Math.PI);
  fillColor.checked ? ctx.fill() : ctx.stroke();
};

const drawTriangle = (pos) => {
  ctx.beginPath();
  ctx.moveTo(prevMouseX, prevMouseY);
  ctx.lineTo(pos.x, pos.y);
  ctx.lineTo(prevMouseX * 2 - pos.x, pos.y);
  ctx.closePath();
  fillColor.checked ? ctx.fill() : ctx.stroke();
};

/* Start drawing (brush/eraser) or shape */
const startDraw = (e) => {
  if (!ensureCanvasReady()) return;
  if (selectedTool === "marker") {
    if (!selectedMarker) return;
    const pos = getMousePos(e);
    createMarkerStamp(pos.x, pos.y, selectedMarker);
    const t = batch[state.tIdx];
    if (t && t.task_id) saveMarkersForTask(t.task_id);
    return;
  }
  isDrawing = true;
  hasDrawn = true;
  const pos = getMousePos(e);
  prevMouseX = pos.x;
  prevMouseY = pos.y;

  // Use thicker width for eraser
  if (selectedTool === "eraser") {
    ctx.lineWidth = eraserWidth;
    ctx.strokeStyle = "#fff";
  } else {
    ctx.lineWidth = brushWidth;
    ctx.strokeStyle = selectedColor;
  }

  ctx.fillStyle = selectedColor;
  takeSnapshot();
  const t = batch[state.tIdx];
  if (t && t.task_id) {
    recordStrokeStart(t.task_id);
    currentStrokePoints = []; // reset
    // also log first point
    const pos = getMousePos(e);
    recordStrokePoint(t.task_id, pos.x, pos.y);
  }
  if (t && t.task_id) {
    pushUndo(t.task_id);
  }
  ctx.beginPath();
  if (selectedTool === "brush" || selectedTool === "eraser") {
    ctx.moveTo(prevMouseX, prevMouseY);
  }
};

const drawing = (e) => {
  if (!isDrawing) return;
  if (snapshot) ctx.putImageData(snapshot, 0, 0);

  const pos = getMousePos(e);
  const t = batch[state.tIdx];
  if (t && t.task_id) recordStrokePoint(t.task_id, pos.x, pos.y);

  if (selectedTool === "brush" || selectedTool === "eraser") {
    ctx.strokeStyle = (selectedTool === "eraser") ? "#fff" : selectedColor;
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
  } else if (selectedTool === "rectangle") {
    drawRect(pos);
  } else if (selectedTool === "circle") {
    drawCircle(pos);
  } else if (selectedTool === "triangle") {
    drawTriangle(pos);
  } else if (selectedTool === "line") {
    drawLine(pos);
  }
};

function ensureTextBoxStore(taskId) {
  state.textBoxesByTask = state.textBoxesByTask || {};
  state.textBoxesByTask[taskId] = state.textBoxesByTask[taskId] || [];
  return state.textBoxesByTask[taskId];
}

function ensureMarkerStore(taskId) {
  state.markersByTask = state.markersByTask || {};
  state.markersByTask[taskId] = state.markersByTask[taskId] || [];
  return state.markersByTask[taskId];
}

function getCurrentTaskId() {
  const t = batch?.[state.tIdx];
  return t?.task_id || null;
}

function saveTextBoxesForTask(taskId) {
  if (!taskId || !drawingBoard) return;

  const canvasRect = canvas.getBoundingClientRect();

  const boxes = Array.from(document.querySelectorAll(".text-box"));
  const serialized = boxes.map((box) => {
    const id =
      box.dataset.tid ||
      (crypto.randomUUID?.() || String(Date.now() + Math.random()));
    box.dataset.tid = id;

    const content = box.querySelector(".text-content");
    const boxRect = box.getBoundingClientRect(); // ✅ missing in your version

    // ✅ store position relative to CANVAS in CSS px
    const left = boxRect.left - canvasRect.left;
    const top  = boxRect.top  - canvasRect.top;

    return { id, left, top, text: content ? content.innerText : "" };
  });

  state.textBoxesByTask[taskId] = serialized;
  saveState();
}

function saveMarkersForTask(taskId) {
  if (!taskId || !drawingBoard) return;

  const canvasRect = canvas.getBoundingClientRect();

  const markers = Array.from(document.querySelectorAll(".marker-stamp"));
  const serialized = markers.map((marker) => {
    const id =
      marker.dataset.tid ||
      (crypto.randomUUID?.() || String(Date.now() + Math.random()));
    marker.dataset.tid = id;

    const boxRect = marker.getBoundingClientRect();
    const left = boxRect.left - canvasRect.left;
    const top = boxRect.top - canvasRect.top;

    return {
      id,
      left,
      top,
      width: boxRect.width,
      height: boxRect.height,
      src: marker.dataset.src || "",
    };
  });

  state.markersByTask[taskId] = serialized;
  saveState();
}

function clearTextBoxesFromDOM() {
  document.querySelectorAll(".text-box").forEach(b => b.remove());
}

function clearMarkersFromDOM() {
  document.querySelectorAll(".marker-stamp").forEach(m => m.remove());
}

function restoreTextBoxesForTask(taskId) {
  if (!taskId || !drawingBoard) return;

  clearTextBoxesFromDOM();

  const saved = state.textBoxesByTask?.[taskId] || [];
  saved.forEach(tb => {
    createTextBox(tb.left, tb.top, { id: tb.id, text: tb.text, focus: false });
  });
}

function restoreMarkersForTask(taskId) {
  if (!taskId || !drawingBoard) return;

  clearMarkersFromDOM();

  const saved = state.markersByTask?.[taskId] || [];
  saved.forEach(m => {
    createMarkerStamp(m.left, m.top, m.src, {
      id: m.id,
      width: m.width,
      height: m.height,
      focus: false,
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  drawingBoard = document.querySelector(".drawing-board");
});

function createTextBox(x, y, opts = {}) {
  const taskId = getCurrentTaskId();

  const boardRect = drawingBoard.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();

  // ✅ convert canvas-relative coords into board-relative coords for positioning
  const leftInBoard = (canvasRect.left - boardRect.left) + x;
  const topInBoard  = (canvasRect.top  - boardRect.top)  + y;

  const textBox = document.createElement("div");
  textBox.className = "text-box";
  textBox.style.left = `${leftInBoard}px`;
  textBox.style.top  = `${topInBoard}px`;
  textBox.dataset.tid = opts.id || (crypto.randomUUID?.() || String(Date.now() + Math.random()));

  const textContent = document.createElement("div");
  textContent.className = "text-content";
  textContent.contentEditable = true;
  textContent.spellcheck = false;
  textContent.innerText = (opts.text != null ? opts.text : "Type here...");

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "close-btn";
  closeBtn.textContent = "✕";
  closeBtn.onclick = () => {
    textBox.remove();
    if (taskId) saveTextBoxesForTask(taskId);
  };

  textBox.appendChild(textContent);
  textBox.appendChild(closeBtn);
  drawingBoard.appendChild(textBox);

  // typing persistence (throttled)
  let typingTimer = null;
  textContent.addEventListener("input", () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      if (taskId) saveTextBoxesForTask(taskId);
    }, 250);
  });

  makeDraggable(textBox, () => {
    if (taskId) saveTextBoxesForTask(taskId);
  });

  if (opts.focus !== false) textContent.focus();
  return textBox;
}

function createMarkerStamp(x, y, src, opts = {}) {
  const taskId = getCurrentTaskId();
  if (!src) return null;

  const boardRect = drawingBoard.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();

  const leftInBoard = (canvasRect.left - boardRect.left) + x;
  const topInBoard  = (canvasRect.top  - boardRect.top)  + y;

  const marker = document.createElement("div");
  marker.className = "marker-stamp";
  marker.style.left = `${leftInBoard}px`;
  marker.style.top = `${topInBoard}px`;
  marker.style.width = `${opts.width || 48}px`;
  marker.style.height = `${opts.height || 48}px`;
  marker.dataset.tid = opts.id || (crypto.randomUUID?.() || String(Date.now() + Math.random()));
  marker.dataset.src = src;

  const img = document.createElement("img");
  img.src = BASE + "/static/" + src;
  img.alt = "marker";
  marker.appendChild(img);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "close-btn";
  closeBtn.textContent = "✕";
  closeBtn.onclick = () => {
    marker.remove();
    if (taskId) saveMarkersForTask(taskId);
  };

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "marker-resize";

  marker.appendChild(closeBtn);
  marker.appendChild(resizeHandle);
  drawingBoard.appendChild(marker);

  makeDraggable(marker, () => {
    if (taskId) saveMarkersForTask(taskId);
  });
  makeResizable(marker, resizeHandle, () => {
    if (taskId) saveMarkersForTask(taskId);
  });

  return marker;
}

function makeDraggable(el, onDragEnd) {
  let offsetX = 0, offsetY = 0, isDragging = false;

  el.addEventListener("mousedown", (e) => {
    // Only drag when clicking the outer box (not when editing text)
    if (e.target.closest(".text-content")) return;
    if (e.target.closest(".marker-resize")) return;
    if (e.target.closest(".close-btn")) return;

    isDragging = true;
    const r = el.getBoundingClientRect();
    offsetX = e.clientX - r.left;
    offsetY = e.clientY - r.top;
    el.style.cursor = "move";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;

    const boardRect = drawingBoard.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const boxRect = el.getBoundingClientRect();

    let left = (e.clientX - boardRect.left) - offsetX;
    let top  = (e.clientY - boardRect.top) - offsetY;

    const canvasLeftInBoard = canvasRect.left - boardRect.left;
    const canvasTopInBoard  = canvasRect.top  - boardRect.top;

    const minLeft = canvasLeftInBoard;
    const minTop  = canvasTopInBoard;
    const maxLeft = canvasLeftInBoard + canvasRect.width  - boxRect.width;
    const maxTop  = canvasTopInBoard  + canvasRect.height - boxRect.height;

    left = Math.max(minLeft, Math.min(maxLeft, left));
    top  = Math.max(minTop,  Math.min(maxTop,  top));

    el.style.left = `${left}px`;
    el.style.top  = `${top}px`;
  });

  window.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    el.style.cursor = el.classList.contains("text-box") ? "text" : "move";
    if (typeof onDragEnd === "function") onDragEnd();
  });
}

function makeResizable(el, handleEl, onResizeEnd) {
  let isResizing = false;
  let startX = 0, startY = 0;
  let startW = 0, startH = 0;

  handleEl.addEventListener("mousedown", (e) => {
    isResizing = true;
    const r = el.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startW = r.width;
    startH = r.height;
    e.preventDefault();
    e.stopPropagation();
  });

  window.addEventListener("mousemove", (e) => {
    if (!isResizing) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const size = Math.max(20, Math.min(240, Math.max(startW + dx, startH + dy)));
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
  });

  window.addEventListener("mouseup", () => {
    if (!isResizing) return;
    isResizing = false;
    if (typeof onResizeEnd === "function") onResizeEnd();
  });
}

function snapshotCanvasToState(taskId) {
  if (!isCanvasBlank(canvas)) {
    state.drawings[taskId] = canvas.toDataURL("image/png");
    saveState();
  }
}

function exportPngWithText() {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  // offscreen canvas at SAME resolution as the real canvas buffer
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const octx = out.getContext("2d");

  // copy the drawn pixels
  octx.drawImage(canvas, 0, 0);

  // draw the text overlays
  const boxes = document.querySelectorAll(".text-box");
  boxes.forEach(box => {
    const textEl = box.querySelector(".text-content");
    if (!textEl) return;

    const style = window.getComputedStyle(textEl);
    const fontSize = parseFloat(style.fontSize) || 14;

    octx.font = `${fontSize * scaleY}px ${style.fontFamily || "Arial"}`;
    octx.fillStyle = style.color || "#000";
    octx.textBaseline = "top";

    const boxRect = box.getBoundingClientRect();
    const x = (boxRect.left - rect.left) * scaleX;
    const y = (boxRect.top - rect.top) * scaleY;

    // multi-line support
    const lines = (textEl.innerText || "").split("\n");
    const lineH = (fontSize * scaleY) * 1.2;
    lines.forEach((line, i) => octx.fillText(line, x, y + i * lineH));
  });

  const markers = document.querySelectorAll(".marker-stamp");
  markers.forEach(marker => {
    const img = marker.querySelector("img");
    if (!img || !img.complete) return;

    const boxRect = marker.getBoundingClientRect();
    const x = (boxRect.left - rect.left) * scaleX;
    const y = (boxRect.top - rect.top) * scaleY;
    const w = boxRect.width * scaleX;
    const h = boxRect.height * scaleY;

    octx.drawImage(img, x, y, w, h);
  });

  return out.toDataURL("image/png");
}

const endDraw = (e) => {
  if (!isDrawing) return;
  isDrawing = false;
  // commit current drawing to state
  const t = batch[state.tIdx];
  if (t && t.task_id) recordStrokeEnd(t.task_id);
  if (t && t.task_id) {
    commitDrawingSnapshotToState(t.task_id);
  }
};

/* wire up tool buttons */
toolBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    // remove active on previous
    const prev = document.querySelector(".tool.active");
    if (prev) prev.classList.remove("active");
    btn.classList.add("active");
    selectedTool = btn.id; // expects btn.id to equal a tool name: brush, eraser, rectangle, circle, triangle
    selectedMarker = null;
    markerBtns.forEach(m => m.classList.remove("active"));
  });
});

markerBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    markerBtns.forEach(m => m.classList.remove("active"));
    btn.classList.add("active");
    selectedTool = "marker";
    selectedMarker = btn.dataset.marker || "";

    const prev = document.querySelector(".tool.active");
    if (prev) prev.classList.remove("active");
  });
});

/* brush size */
if (sizeSlider) {
  sizeSlider.addEventListener("input", () => {
    baseWidth = Number(sizeSlider.value) || 1;
    brushWidth = baseWidth;          // pen size
    eraserWidth = baseWidth * 10;     // eraser is 3× thicker (tune as you like)
  });
}

/* color swatches and picker */
colorBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    const prev = document.querySelector(".colors .option.selected");
    if (prev) prev.classList.remove("selected");
    btn.classList.add("selected");
    // read computed background color as rgb string
    selectedColor = window.getComputedStyle(btn).getPropertyValue("background-color");
  });
});
if (colorPicker) {
  colorPicker.addEventListener("change", () => {
    colorPicker.parentElement.style.background = colorPicker.value;
    selectedColor = colorPicker.value;
  });
}

/* clear canvas */
if (clearCanvasBtn) {
  clearCanvasBtn.addEventListener("click", () => {
    resizeCanvasToDisplay();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setCanvasBackground();
    hasDrawn = false;
    const t = batch[state.tIdx];
    if (t && t.task_id) {
      commitDrawingSnapshotToState(t.task_id);
      // pushing clear action to undo
      pushUndo(t.task_id);
    }
  });
}

/* undo/redo buttons */
if (undoBtn) undoBtn.addEventListener("click", () => {
  const t = batch[state.tIdx];
  if (t && t.task_id) doUndo(t.task_id);
});
if (redoBtn) redoBtn.addEventListener("click", () => {
  const t = batch[state.tIdx];
  if (t && t.task_id) doRedo(t.task_id);
});

/* save image button (manual) */
if (saveImgBtn) saveImgBtn.addEventListener("click", async () => {
  const t = batch[state.tIdx];
  if (!t) return;

  commitCurrentDrawing(t.task_id);

  if (isCanvasBlank(canvas)) {
    alert("You cannot save an empty board!");
    return;
  }

  const png = exportPngWithText(); // ✅ includes DOM text boxes

  const result = await saveDrawingToBackend(t.task_id, png);
  if (result?.file) state.drawing_paths[t.task_id] = result.file;

  // Keep editable snapshot in browser state (pixels only is fine)
  commitDrawingSnapshotToState(t.task_id);
  alert("Drawing saved.");
});

/* Canvas mouse events */
if (canvas && ctx) {
  canvas.addEventListener("mousedown", startDraw);
  canvas.addEventListener("mousedown", (e) => {
    if (selectedTool === "text") {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      createTextBox(x, y);
      const taskId = getCurrentTaskId();
      if (taskId) saveTextBoxesForTask(taskId);
    }
  });
  canvas.addEventListener("mousemove", drawing);
  canvas.addEventListener("mouseup", endDraw);
  canvas.addEventListener("mouseleave", endDraw);

  /* On window load / resize, size canvas and load background */
  window.addEventListener("load", () => {
    resizeCanvasToDisplay();
    setCanvasBackground();
  });

  let _resizeTimer = null;

  window.addEventListener("resize", () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      const taskId = getCurrentTaskId();

      const oldRect = canvas.getBoundingClientRect();
      if (taskId) saveTextBoxesForTask(taskId);
      if (taskId) saveMarkersForTask(taskId);

      const dataUrl = canvas.toDataURL("image/png");

      const img = new Image();
      img.onload = () => {
        resizeCanvasToDisplay();

        setCanvasBackground();
        const { w, h } = getCanvasCssSize();
        ctx.drawImage(img, 0, 0, w, h);

        const newRect = canvas.getBoundingClientRect();
        const sx = oldRect.width  ? (newRect.width  / oldRect.width)  : 1;
        const sy = oldRect.height ? (newRect.height / oldRect.height) : 1;

        if (!taskId) return;
        const saved = ensureTextBoxStore(taskId);
        saved.forEach(tb => {
          tb.left *= sx;
          tb.top  *= sy;
        });
        saveState();

        restoreTextBoxesForTask(taskId);
        const savedMarkers = ensureMarkerStore(taskId);
        savedMarkers.forEach(m => {
          m.left *= sx;
          m.top  *= sy;
          m.width *= sx;
          m.height *= sy;
        });
        saveState();
        restoreMarkersForTask(taskId);

        if (taskId) commitDrawingSnapshotToState(taskId);
      };
      img.src = dataUrl;
    }, 150);
  });
}

/* Preload saved drawing for a task */
function loadDrawingForTask(task_id) {
  const base64 =
    state.drawings[task_id] ||
    (state.savedAns[task_id] && state.savedAns[task_id].drawing);

  resizeCanvasToDisplay();
  setCanvasBackground();

  if (base64) {
    const img = new Image();
    img.onload = () => {
      const { w, h } = getCanvasCssSize();
      ctx.drawImage(img, 0, 0, w, h);
    };
    img.src = base64;
  }
}

/* initCanvas called when rendering a task */
function initCanvas(t) {
  if (!t) return;
  // create stacks if absent
  if (!undoStacks[t.task_id]) undoStacks[t.task_id] = [];
  if (!redoStacks[t.task_id]) redoStacks[t.task_id] = [];

  // load any saved drawing
  loadDrawingForTask(t.task_id);
  restoreTextBoxesForTask(t.task_id);
  restoreMarkersForTask(t.task_id);

  // reset local flags
  hasDrawn = !!state.drawings[t.task_id];
}

const MAX_ENTROPY_POINTS = 2000; // cap to avoid bloating localStorage
let currentStrokePoints = [];    // temp buffer while dragging

function recordStrokeStart(taskId) {
  const m = getTaskMetrics(taskId);
  const now = performance.now();
  if (!m.drawing) m.drawing = { strokeCount: 0, firstStrokeMs: null, lastStrokeMs: null, points: [] };

  if (m.drawing.firstStrokeMs == null) m.drawing.firstStrokeMs = now;
}

function recordStrokeEnd(taskId) {
  const m = getTaskMetrics(taskId);
  const now = performance.now();
  if (!m.drawing) return;

  m.drawing.strokeCount = (m.drawing.strokeCount || 0) + 1;
  m.drawing.lastStrokeMs = now;

  // append sampled points
  if (!Array.isArray(m.drawing.points)) m.drawing.points = [];
  for (const p of currentStrokePoints) m.drawing.points.push(p);

  // cap size
  if (m.drawing.points.length > MAX_ENTROPY_POINTS) {
    m.drawing.points = m.drawing.points.slice(m.drawing.points.length - MAX_ENTROPY_POINTS);
  }

  currentStrokePoints = [];
  saveState();
}

function recordStrokePoint(taskId, x, y) {
  // sample lightly (every ~3-5px movement) to keep it cheap
  const last = currentStrokePoints[currentStrokePoints.length - 1];
  if (last) {
    const dx = x - last.x, dy = y - last.y;
    if ((dx*dx + dy*dy) < 16) return; // <4px => skip
  }
  currentStrokePoints.push({ x, y });
}

function computeStrokeEntropy01(taskId, grid = 8) {
  const m = getTaskMetrics(taskId);
  const pts = m.drawing?.points || [];
  if (pts.length < 20) return 0;

  const counts = new Array(grid * grid).fill(0);

  for (const p of pts) {
    // points are in canvas coordinates already (0..canvas.width/height)
    let cx = Math.floor((p.x / canvas.width) * grid);
    let cy = Math.floor((p.y / canvas.height) * grid);
    cx = Math.max(0, Math.min(grid - 1, cx));
    cy = Math.max(0, Math.min(grid - 1, cy));
    counts[cy * grid + cx] += 1;
  }

  const total = pts.length;
  let H = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / total;
    H -= p * Math.log(p);
  }

  const Hmax = Math.log(grid * grid);
  return Hmax > 0 ? (H / Hmax) : 0; // 0..1
}
// ------------------ Move to Landmarks Page ------------------
const goToLandmarksBtn = document.getElementById("go-to-landmarks-btn");
if (goToLandmarksBtn && IS_DRAW) goToLandmarksBtn.addEventListener("click", async () => {
  if (isCanvasBlank(canvas)) {
    alert("You cannot save an empty board!");
    return;
  }

  const t = batch[state.tIdx];
  if (!t) return;

  finalizeVideoMetricsNow(t.task_id);

  const gate = checkEffortRequirements(t.task_id);
  if (!gate.ok) {
    alert(gate.reason);
    return;
  }

  saveMarkersForTask(t.task_id);
  const markerGate = validateMarkersPresentOnce();
  if (!markerGate.ok) {
    alert(markerGate.reason);
    return;
  }

  const proceed = confirm("Moving to landmarks page. You will not be able to return to drawing.\n\nDo you want to continue?");
  if (!proceed) return;

  // commit snapshot
  commitCurrentDrawing(t.task_id);
  const png = exportPngWithText();
  const result = await saveDrawingToBackend(t.task_id, png);
  if (result?.file) state.drawing_paths[t.task_id] = result.file;

  await saveCurrentTaskToBackend(); // saves metrics/landmarks/etc

  // Force a backend upload of the current drawing before leaving drawing page
  if (state.drawings[t.task_id] && !state.drawing_paths[t.task_id]) {
    if (result && result.file) state.drawing_paths[t.task_id] = result.file;
  }

  const m = getTaskMetrics(t.task_id);
  m.interactions.clickedGoToLandmarksMs = performance.now();
  m.timing.landmarkEnterMs = performance.now();
  // finalize drawing duration from page enter
  m.timing.drawingDurationMs = performance.now() - m.timing.pageEnterMs;

  saveState();

  show("task-page");
  renderLandmarksUI(t);

  console.log("drawing_paths raw:", state.drawing_paths[t.task_id]);
  console.log("drawings raw:", state.drawings[t.task_id]);

  const savedImgEl = document.getElementById("saved-drawing-img");
  if (savedImgEl) {
    savedImgEl.src = state.drawing_paths[t.task_id] || state.drawings[t.task_id] || "";
  }
});

// ------------------ Task Metrics ------------------
function startTaskTimer(taskId) {
  if (!taskId) return;
  const m = getTaskMetrics(taskId);
  m.startTime = performance.now();
  m.timing.landmarkEnterMs = null;
  saveState();
}

function startLandmarkTimer(taskId) {
  if (!taskId) return;
  const m = getTaskMetrics(taskId);
  m.timing.landmarkEnterMs = performance.now();
  saveState();
}

function finalizeTaskMetrics() {
  const m = getTaskMetrics(t.task_id);
  m.interactions.drawingDurationMs =
    performance.now() - m.timing.pageEnterMs;
  saveState();
}

function finalizeLandmarkMetrics(taskId) {
  const m = getTaskMetrics(taskId);
  if (m.timing.landmarkEnterMs != null) {
    m.timing.landmarkDurationMs = performance.now() - m.timing.landmarkEnterMs;
  }
  saveState();
}

function finalizeVideoMetricsNow(taskId) {
  finalizeWatchIfPlaying(taskId); // you already have this
  saveState();
}

function checkEffortRequirements(taskId) {
  const m = getTaskMetrics(taskId);

  const MIN_REACHED_FRAC = 0.70;
  const MIN_WATCH_FRAC = 0.50;

  if (IS_DRAW) {
    const N_STROKES = 10;
    const K_SECONDS = 10;      // between first and last stroke
    const MIN_ENTROPY = 0.25;

    const strokeCount = m.drawing?.strokeCount || 0;
    if (strokeCount < N_STROKES) {
      return { ok: false, reason: `Please draw a bit more detail on your map.` };
    }

    const first = m.drawing?.firstStrokeMs;
    const last  = m.drawing?.lastStrokeMs;
    if (first == null || last == null || (last - first) < K_SECONDS * 1000) {
      return { ok: false, reason: `Please spend some more time drawing before proceeding.` };
    }

    const entropy = computeStrokeEntropy01(taskId, 8);
    if (entropy < MIN_ENTROPY) {
      return { ok: false, reason: `Please draw the route and landmarks more fully across the canvas (not just in one small area).` };
    }
  }

  // --- video checks ---
  const video = document.getElementById("obs-video");
  const dur = (video && isFinite(video.duration)) ? video.duration : null;

  if (dur != null && dur > 0) {
    const reached = m.video?.maxWatchedTime || 0;
    const watchMs = m.video?.totalWatchTimeMs || 0;

    if (reached < MIN_REACHED_FRAC * dur) {
      return { ok: false, reason: `Please watch more of the video before proceeding.` };
    }
    if (watchMs < MIN_WATCH_FRAC * dur * 1000) {
      return { ok: false, reason: `Please spend a bit more time watching the video before proceeding.` };
    }
  }

  return { ok: true, reason: "ok" };
}

function validateMarkersPresentOnce() {
  const required = [
    "icons/badge_S.png",
    "icons/badge_A.png",
    "icons/badge_B.png",
    "icons/badge_C.png",
    "icons/badge_G.png",
  ];

  const counts = Object.fromEntries(required.map(r => [r, 0]));
  const markers = document.querySelectorAll(".marker-stamp");
  markers.forEach(m => {
    const src = m.dataset.src || "";
    if (src in counts) counts[src] += 1;
  });

  const missing = required.filter(r => counts[r] === 0);
  const dupes = required.filter(r => counts[r] > 1);

  if (missing.length || dupes.length) {
    const labels = (arr) => arr.map(s => s.replace("icons/badge_", "").replace(".png", ""));
    let msg = "Please place each marker exactly once.";
    if (missing.length) msg += ` Missing: ${labels(missing).join(", ")}.`;
    if (dupes.length) msg += ` Duplicates: ${labels(dupes).join(", ")}.`;
    return { ok: false, reason: msg };
  }

  return { ok: true };
}

// ------------------ Autosave ------------------
function startAutoSave() {
  if (autoSaveTimer) clearInterval(autoSaveTimer);
  autoSaveTimer = setInterval(() => {
    saveCurrentTaskToBackend();
  }, AUTOSAVE_INTERVAL_MS);
}

async function saveCurrentTaskToBackend() {
  const t = batch[state.tIdx];
  if (!t) return;

  const taskId = t.task_id;
  const m = getTaskMetrics(taskId);

  // Save drawing if on task page (draw app only)
  if (IS_DRAW && state.currentPage === "task-page") {
    // persist editable state
    saveTextBoxesForTask(taskId);
    snapshotCanvasToState(taskId);

    // upload an image that includes text overlays
    const png = exportPngWithText();

    if (!state.drawing_paths[taskId]) {
      const result = await saveDrawingToBackend(taskId, png);
      if (result?.file) state.drawing_paths[taskId] = result.file;
    } else {
      // optional: if you want autosave to overwrite/update each time,
      // still call saveDrawingToBackend(taskId, png) and let backend replace it.
      saveDrawingToBackend(taskId, png)
    }

    m.timing.drawingDurationMs = performance.now() - m.timing.pageEnterMs;
  }

  const landmarks = state.landmarks[taskId] || [];

  const payload = {
    task_id: taskId,
    landmarks,
    drawing: state.drawings[taskId] || null,
    task_metrics: m,
    prolific_id: state.prolific?.pid || null
  };

  console.log("Sending save_answer payload:", payload);

  try {
    await fetch(BASE + "/save_answer", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.warn("save_answer failed:", err);
  }

  saveState();
}

/* Save drawing to backend (separate endpoint) */
async function saveDrawingToBackend(task_id, base64image) {
  try {
    const res = await fetch(BASE + "/save_drawing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: task_id, image: base64image })
    });

    if (!res.ok) {
      throw new Error(`HTTP error! Status: ${res.status}`);
    }

    const result = await res.json(); // parse backend JSON
    return result;
  } catch (err) {
    console.warn("saveDrawingToBackend failed:", err);
    return { success: false, error: err.message };
  }
}


/* Save landmarks to backend (separate endpoint) */
async function saveLandmarksToBackend(task_id, landmarks) {
  try {
    await fetch(BASE + "/save_landmarks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: task_id, landmarks: landmarks })
    });
  } catch (err) {
    console.warn("saveLandmarksToBackend failed:", err);
  }
}

// ------------------ Validate Landmarks ------------------
function validateLandmarks(landmarks, endpointOrder) {
  console.log("Validating landmarks:", landmarks, "with endpoint order:", endpointOrder);
  // ---------- Rule 1: start ----------
  if (!landmarks[0].toLowerCase().includes("start")) {
    return { valid: false, reason: "First landmark must contain 'start'" };
  }

  // ---------- Rule 2: end ----------
  if (!landmarks[landmarks.length - 1].toLowerCase().includes("end")) {
    return { valid: false, reason: "Last landmark must contain 'end'" };
  }

  // ---------- Rule 3: must include all required endpoints ----------
  const requiredEndpoints = endpointOrder.map(
    e => `point ${e.toLowerCase()}`
  );

  for (let ep of requiredEndpoints) {
    if (!landmarks.some(l => l.toLowerCase().includes(ep))) {
      return { valid: false, reason: `Missing ${ep}` };
    }
  }

  // ---------- Rule 4: no two endpoints adjacent ----------
  for (let i = 0; i < landmarks.length - 1; i++) {
    if (
      landmarks[i].toLowerCase().includes("point") &&
      landmarks[i + 1].toLowerCase().includes("point")
    ) {
      return { valid: false, reason: "No two points may be adjacent (must have a separating landmark)" };
    }
  }

  // ---------- Rule 5: endpoints must follow task-defined order ----------
  const observedOrder = [];

  for (let l of landmarks) {
    const m = l.toLowerCase().match(/point\s+([abc])/);
    if (m) {
      observedOrder.push(m[1].toUpperCase());
    }
  }

  // observedOrder should match endpointOrder exactly
  if (observedOrder.length !== endpointOrder.length) {
    return {
      valid: false,
      reason: "Incorrect number of points"
    };
  }

  for (let i = 0; i < endpointOrder.length; i++) {
    if (observedOrder[i] !== endpointOrder[i]) {
      return {
        valid: false,
        reason: `Points must appear in order ${endpointOrder.join(" → ")}`
      };
    }
  }

  // ---------- All checks passed ----------
  return { valid: true, reason: "Valid landmark sequence" };
}

// Save landmarks button
const saveLandmarksBtn = document.getElementById("save-landmarks-btn");
if (saveLandmarksBtn && IS_LANDMARK) {
  saveLandmarksBtn.addEventListener("click", async () => {
    const t = batch[state.tIdx];
    if (!t) return;

    const landmarks = getCurrentTaskLandmarks(t);
    if (landmarks.length === 0) {
      alert("No landmarks entered.");
      return;
    }

    const result = validateLandmarks(landmarks, t.endpoint_order || []);
    if (!result.valid) {
      alert("Validation failed: " + result.reason);
      return;
    }

    try {
      await saveLandmarksToBackend(t.task_id, landmarks);
      alert("Landmarks saved successfully!");
    } catch (err) {
      console.error("Error saving landmarks:", err);
      alert("Failed to save landmarks, please try again.");
    }
  });
}


// ------------------ Save & Next ------------------
const saveBtn = document.getElementById("save-btn");
if (saveBtn) {
  saveBtn.onclick = async () => {
    const t = batch[state.tIdx];
    if (!t) return;

    if (IS_LANDMARK) {
      const lms = getCurrentTaskLandmarks(t);
      if (lms.length === 0) {
        alert("No landmarks entered.");
        return;
      }

      const landmarkValidation = validateLandmarks(lms, t.endpoint_order || []);
      if (!landmarkValidation.valid) {
        alert("Landmark validation failed: " + landmarkValidation.reason);
        return;
      }

      finalizeLandmarkMetrics(t.task_id);
      finalizeVideoMetricsNow(t.task_id);
      getTaskMetrics(t.task_id).interactions.clickedSaveNextMs = performance.now();

      await saveCurrentTaskToBackend();
    } else {
      if (isCanvasBlank(canvas)) {
        alert("You cannot save an empty board!");
        return;
      }

      finalizeVideoMetricsNow(t.task_id);
      const gate = checkEffortRequirements(t.task_id);
      if (!gate.ok) {
        alert(gate.reason);
        return;
      }

      saveMarkersForTask(t.task_id);
      const markerGate = validateMarkersPresentOnce();
      if (!markerGate.ok) {
        alert(markerGate.reason);
        return;
      }

      commitCurrentDrawing(t.task_id);
      const png = exportPngWithText();
      const result = await saveDrawingToBackend(t.task_id, png);
      if (result?.file) state.drawing_paths[t.task_id] = result.file;

      await saveCurrentTaskToBackend();
    }

    if (state.tIdx < batch.length - 1) {
      state.tIdx++;
      renderTask();
      updateRouteIndicator();
      show("task-page");
      startAutoSave();
    } else {
      alert("No more tasks in this batch.");
    }
  };
}

// ------------------ Submit All ------------------
const submitAllBtn = document.getElementById("submit-all-btn");
if (submitAllBtn) {
  submitAllBtn.onclick = async () => {
    try {
      const t = batch[state.tIdx];
      if (!t) return;

      if (IS_LANDMARK) {
        const lms = getCurrentTaskLandmarks(t);
        if (lms.length === 0) {
          alert("No landmarks entered.");
          return;
        }

        const v = validateLandmarks(lms, t.endpoint_order || []);
        if (!v.valid) {
          alert("Landmark validation failed: " + v.reason);
          return;
        }

        finalizeLandmarkMetrics(t.task_id);
        await saveCurrentTaskToBackend();
      } else {
        if (isCanvasBlank(canvas)) {
          alert("You cannot submit an empty board!");
          return;
        }

        finalizeVideoMetricsNow(t.task_id);
        const gate = checkEffortRequirements(t.task_id);
        if (!gate.ok) {
          alert(gate.reason);
          return;
        }

        saveMarkersForTask(t.task_id);
        const markerGate = validateMarkersPresentOnce();
        if (!markerGate.ok) {
          alert(markerGate.reason);
          return;
        }

        commitCurrentDrawing(t.task_id);
        const png = exportPngWithText();
        const result = await saveDrawingToBackend(t.task_id, png);
        if (result?.file) state.drawing_paths[t.task_id] = result.file;

        await saveCurrentTaskToBackend();
      }

      const resp = await fetch(BASE + "/complete", { method: "POST" });
      const data = await resp.json();

      if (data.status !== "ok") {
        alert("Submission failed. Please contact the researcher.");
        return;
      }

      window.location.href = data.completion_url;

    } catch (err) {
      console.error("Submission error:", err);
      alert("Submission error. Please try again or contact the researcher.");
    }
  };
}

// Update the visibility of save and submit buttons based on the current question
function updateSaveButtons() {
    if (state.tIdx === batch.length - 1) {
        document.getElementById('save-btn').style.display = 'none';
        document.getElementById('submit-all-btn').style.display = 'block';
    } else {
        document.getElementById('save-btn').style.display = 'block';
        document.getElementById('submit-all-btn').style.display = 'none';
    }
}

/* ------------------ Helpful: save state before unload ------------------ */
/* ------------------ Save state safely before unload ------------------ */
window.addEventListener("beforeunload", () => {
  const t = batch?.[state.tIdx];
  if (!t || !t.task_id) return;

  const taskId = t.task_id;

  // 1) Persist text boxes (DOM → state)
  saveTextBoxesForTask(taskId);
  saveMarkersForTask(taskId);

  // 2) Persist canvas pixels (no flattening)
  commitDrawingSnapshotToState(taskId);

  // 3) Save local state
  saveState();

  // NOTE:
  // Do NOT call flattenTextToCanvas() here.
  // Flattening deletes DOM text boxes and breaks refresh persistence.
});
