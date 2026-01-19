// static/js/app.js

const BASE = ""; // set to "" if running on localhost
// const BASE = "http://windoek.sp.cs.cmu.edu:8000"; // set to your server URL
const STORAGE_KEY = "napkinMapSurveyState";
const AUTOSAVE_INTERVAL_MS = 10000;
const UNDO_LIMIT = 10;

/* ---------------- In-memory state ---------------- */
let batch = [], savedAns = {};
let taskMetrics = {};
let autoSaveTimer = null;

let state = {
  currentPage: "instr-page",
  batch: [],
  savedAns: {},
  tIdx: 0,
  obsIdxPerTask: {}, // map task_id -> obs idx
  drawings: {},      // map task_id -> base64 image (finalized)
  drawing_paths: {},
  landmarks: {}      // map task_id -> array of strings
};

// Restore from localStorage

// ------------------ Restore State ------------------
document.addEventListener("DOMContentLoaded", async () => {
  console.log("DOM fully loaded and parsed, restoring state...");
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    console.log("Restored state:", saved);
    if (saved) Object.assign(state, saved);
  } catch (e) {
    console.warn("Could not parse saved state:", e);
  }

  // Show whatever page we were on last
  show(state.currentPage);

  // Reattach batch / savedAns from state if present
  if (Array.isArray(state.batch) && state.batch.length > 0) {
    batch = state.batch;
    savedAns = state.savedAns || {};
  }

  console.log("Current page:", state.currentPage);
  console.log("State before restoration/initial load:", state);

  if (state.currentPage === "task-page") {
    // Normal restore for drawing page
    if (!Array.isArray(batch) || batch.length === 0) {
      console.log("No batch loaded, fetching next batch...");
      await fetchBatch();
      batch = state.batch;
      savedAns = state.savedAns || {};
    }
    renderTask();
    startAutoSave();

  } else if (state.currentPage === "landmark-page") {
    // NEW: restore when reloading on landmarks page
    if (!Array.isArray(batch) || batch.length === 0) {
      console.log("No batch loaded, fetching next batch...");
      await fetchBatch();
      batch = state.batch;
      savedAns = state.savedAns || {};
    }

    // Make sure tIdx is in range
    if (state.tIdx < 0 || state.tIdx >= batch.length) {
      state.tIdx = 0;
    }
    const t = batch[state.tIdx];

    // Ensure we have landmarks in state; fall back to defaults from backend
    if (!state.landmarks[t.task_id] || state.landmarks[t.task_id].length === 0) {
      state.landmarks[t.task_id] = [...t.landmarks];
    }

    // Render landmark list from state
    renderLandmarksUI(t);

    // Restore saved sketch into the image on the landmark page
    const savedImgEl = document.getElementById("saved-drawing-img");
    if (savedImgEl) {
      savedImgEl.src =
        state.drawing_paths[t.task_id] ||
        state.drawings[t.task_id] ||
        "";
    }

    // Re-init timers / autosave for this task
    startTaskTimer();      // drawing start (approx; we don't know original)
    startLandmarkTimer();  // landmark timer from now
    startAutoSave();
  }

  console.log("State after restoration/initial load:", state);
});

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
      landmarks: {}      // map task_id -> array of strings
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
  if (batch.length === 0) {
    console.log("No batch loaded, skipping saveState.");
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}


// ------------------ Show Page ------------------
function show(pageId) {
  ["instr-page", "quiz-page", "task-page", "landmark-page", "done-page"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove("active");
  });
  const pageEl = document.getElementById(pageId);
  if (pageEl) pageEl.classList.add("active");

  state.currentPage = pageId;
  saveState();
}

// ------------------ Render Example ----------------
// Example observations carousel
const exampleObsImages = [
  "static/images/xULIC_eDnb4APnd71q9c3Q_209.18_sharpened.jpg",
  "static/images/5ITG_G7VUaanqnDdpunTrw_209.1_sharpened.jpg",
  "static/images/6yqplA8nA9Jhb1e_xVZGGQ_208.96_sharpened.jpg",
  "static/images/0wE6axap7dj1qmn4rXTzVA_208.95_sharpened.jpg",
  "static/images/3KqKKj1TmZuJEOZMdbxDFg_208.97_sharpened.jpg",
  "static/images/O0VWr8ynRBO0GihRp_kwVg_202.72_sharpened.jpg",
  "static/images/IaQdSIEo8zsIgnNuBrIqyQ_175.07_sharpened.jpg",
  "static/images/lZ01djzqycDP2Q_pUPSCqw_141.32_sharpened.jpg",
  "static/images/6_RBib5hDlQNlkHkTBRlGg_119.15_sharpened.jpg",
  "static/images/EEr1fMxAX6pwCFgrbySEBQ_118.8_sharpened.jpg",
  "static/images/Z1PbH8EiC_UbQfYWfXPxuQ_119.06_sharpened.jpg",
  "static/images/xnrwjnSHt9S5lef9_3XwxA_119.07_sharpened.jpg",
  "static/images/8wSeB1wzKHEEROwcOLtxnw_119.06_sharpened.jpg",
  "static/images/eQyXeUJ3QleuTBdhJCkCmA_119.07_sharpened.jpg",
  "static/images/svB62DOPbGvgZLrvNSH13g_119.08_sharpened.jpg",
  "static/images/RCnAt06Z9YRq0adMJl7XqQ_119.08_sharpened.jpg",
  "static/images/1bGX-jxd2jFltlLzppbi6w_119.09_sharpened.jpg",
  "static/images/bpTD_75MjdoVxD39EZsavA_119.07_sharpened.jpg",
  "static/images/WjMNYFMG6CnPoeJRdthNmA_119.08_sharpened.jpg",
  "static/images/9eVUhdkTI_g2yIVGkgmcSA_119.07_sharpened.jpg",
  "static/images/aopI6T9aoGnExvlurEHHAA_119.08_sharpened.jpg"
];

let exampleObsIdx = 0;
const exampleObsImg = document.getElementById("example-obs-img");
exampleObsImg.src = exampleObsImages[exampleObsIdx];

document.getElementById("example-prev-obs").onclick = () => {
    exampleObsIdx = Math.max(exampleObsIdx - 1, 0);
    exampleObsImg.src = exampleObsImages[exampleObsIdx];
};
document.getElementById("example-next-obs").onclick = () => {
    exampleObsIdx = Math.min(exampleObsIdx + 1, exampleObsImages.length - 1);
    exampleObsImg.src = exampleObsImages[exampleObsIdx];
};

document.onkeydown = e => {
    if (e.key === "ArrowLeft") document.getElementById("example-prev-obs").click();
    if (e.key === "ArrowRight") document.getElementById("example-next-obs").click();
  };

// ------------------ Render Quiz ------------------
// Example landmarks
const exampleLandmarks = [
  "Start (S)",
  "Gourmet Deli (red colored)",
  "Endpoint 1",
  "La Pulperia",
  "First intersection (9th Ave and W 44th St)",
  "Mama Mia (on the right across the intersection)",
  "Chipotle",
  "Marseille (on the left after turning)",
  "Endpoint 3",
  "Tavern",
  "Vanilla Gorilla (blue colored)",
  "Endpoint 2",
  "End (G)"
];

const quizObsImages = exampleObsImages; // reuse the same set
let quizObsIdx = 0;
const quizObsImg = document.getElementById("quiz-obs-img");
quizObsImg.src = quizObsImages[quizObsIdx];

document.getElementById("quiz-prev-obs").onclick = () => {
  quizObsIdx = Math.max(quizObsIdx - 1, 0);
  quizObsImg.src = quizObsImages[quizObsIdx];
};
document.getElementById("quiz-next-obs").onclick = () => {
  quizObsIdx = Math.min(quizObsIdx + 1, quizObsImages.length - 1);
  quizObsImg.src = quizObsImages[quizObsIdx];
};

document.onkeydown = e => {
    if (e.key === "ArrowLeft") document.getElementById("quiz-prev-obs").click();
    if (e.key === "ArrowRight") document.getElementById("quiz-next-obs").click();
  };

// Fisher-Yates shuffle
function shuffle(array) {
  let arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Render shuffled landmarks into quiz list
function renderQuizLandmarks() {
  const quizList = document.getElementById("quiz-landmark-list");
  quizList.innerHTML = "";
  shuffle(exampleLandmarks).forEach(text => {
    const li = document.createElement("li");
    li.textContent = text;
    li.draggable = true;
    quizList.appendChild(li);
  });
}
renderQuizLandmarks();

// Drag & drop behavior
let draggedItem = null;

document.addEventListener("dragstart", e => {
  if (e.target.tagName === "LI") {
    draggedItem = e.target;
    e.target.style.opacity = "0.5";
  }
});

document.addEventListener("dragend", e => {
  if (e.target.tagName === "LI") {
    draggedItem.style.opacity = "";
    draggedItem = null;
  }
});

document.addEventListener("dragover", e => {
  e.preventDefault();
  const quizList = document.getElementById("quiz-landmark-list");
  if (e.target.tagName === "LI" && quizList.contains(e.target)) {
    const rect = e.target.getBoundingClientRect();
    const offset = e.clientY - rect.top;
    if (offset > rect.height / 2) {
      e.target.parentNode.insertBefore(draggedItem, e.target.nextSibling);
    } else {
      e.target.parentNode.insertBefore(draggedItem, e.target);
    }
  }
});

document.getElementById("begin-btn").onclick = async () => {
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

document.getElementById("submit-quiz-btn").onclick = async () => {
  const quizList = document.querySelectorAll("#quiz-landmark-list li");
  const order = Array.from(quizList).map(li => li.textContent);

  try{
    const res = await fetch("/check_quiz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order })
    });
    const data = await res.json();
    if (data.correct) {
      // ✅ quiz correct → load tasks
      await fetchBatch();
      renderTask();
      show("task-page");
      startAutoSave();
    } else {
      // ❌ quiz incorrect → let user try again
      alert("That order is not correct. Please try again!");
    }
  } catch (err) {
    console.error("Quiz check failed:", err);
    alert("Sorry, something went wrong checking your answer.");
  }
};


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

// --- From instructions to quiz ---
document.getElementById("begin-btn").onclick = () => {
  show("quiz-page");
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
let currentObsIdx = 0;

// Drawing undo/redo stacks per task (in-memory)
const undoStacks = {}; // task_id -> [ImageData]
const redoStacks = {}; // task_id -> [ImageData]

function initTaskMetrics() {
  taskMetrics = { startTime: performance.now(), clicks: {} };
  startTaskTimer();
}

function renderTask(){
  if (!Array.isArray(batch) || batch.length === 0) {
    console.warn("renderTask called too early—batch not loaded");
    return;
  }
  initTaskMetrics();

  const t = batch[state.tIdx];

  // Map
  document.getElementById("map-img").src = BASE + t.map_url;
  console.log("Map loaded from:", BASE + t.map_url);
  
  // Observations
  currentObsIdx = state.obsIdxPerTask[t.task_id] || 0;
  console.log("Current observation index:", currentObsIdx);
  renderObsImage(t);

  document.getElementById("prev-obs").onclick = () => {
    if (currentObsIdx > 0) {
      currentObsIdx--;
      state.obsIdxPerTask[t.task_id] = currentObsIdx;
      renderObsImage(t);
    }
    taskMetrics.clicks.prevObs += 1;
  };

  document.getElementById("next-obs").onclick = () => {
    console.log("Next observation clicked. Current index:", currentObsIdx, "Total images:", t.images.length);
    if (currentObsIdx < t.images.length - 1) {
      currentObsIdx++;
      state.obsIdxPerTask[t.task_id] = currentObsIdx;
      renderObsImage(t);
    }
    taskMetrics.clicks.nextObs += 1;
  };

  // Keyboard nav
  document.onkeydown = e => {
    if (e.key === "ArrowLeft") document.getElementById("prev-obs").click();
    if (e.key === "ArrowRight") document.getElementById("next-obs").click();
  };

  // Drawing pad
  initCanvas(t);

  // Update buttons
  updateSaveButtons();
}

// ------------------ Render Observations ------------------
function renderObsImage(t) {
  console.log("getting observation from: ", BASE)
  document.getElementById("obs-image").src = BASE + t.images[currentObsIdx];
  saveState();
}

// ------------------ Map Zoom on Click ------------------
window.addEventListener("DOMContentLoaded", () => {
  const container = document.getElementById("map-container");
  const openMapBtn = document.getElementById("open-map-btn");
  const mapOverlay = document.getElementById("map-modal");
  const img       = document.getElementById("map-img");
  const closeBtn  = document.getElementById("map-close-btn");
  const hideBtn = document.getElementById("map-hide-btn");

  if (openMapBtn) {
    // Clicking the open button shows the overlay
    openMapBtn.addEventListener("click", () => {
      mapOverlay.classList.add("visible");
    });

    // Clicking the close button hides the overlay
    hideBtn.addEventListener("click", () => {
      mapOverlay.classList.remove("visible");
    });
  }

  if (closeBtn) {
    // Clicking the image zooms in
    img.addEventListener("click", () => {
      container.classList.add("zoomed");
    });

    // Clicking the X zooms back out
    closeBtn.addEventListener("click", () => {
      container.classList.remove("zoomed");
    });
  }
});

// ------------------ Landmarks UI ------------------

// Default scaffold used when a task has no saved landmarks yet
const DEFAULT_LANDMARK_SCAFFOLD = [
  "Start (S)",
  "Endpoint 1",
  "Endpoint 2",
  "Endpoint 3",
  "End (G)"  
];

function renderLandmarksUI(t) {
  const lmList = document.getElementById("landmark-list");
  lmList.innerHTML = "";

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
      taskMetrics.clicks.delLmClick += 1;
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
    taskMetrics.clicks.addLmClick += 1;
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
        taskMetrics.clicks.reorderLm += 1;
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
const clearCanvasBtn = document.querySelector(".clear-canvas");
const saveImgBtn = document.querySelector(".save-img");
const undoBtn = document.getElementById("undo-btn");
const redoBtn = document.getElementById("redo-btn");
const ctx = canvas.getContext("2d");

// Fixed export resolution (e.g. 2000x2000)
const SAVE_WIDTH = 2000;
const SAVE_HEIGHT = 2000;

let prevMouseX = 0, prevMouseY = 0, snapshot = null;
let isDrawing = false, hasDrawn = false;
let selectedTool = "brush";

// base size from slider
let baseWidth = 5;
let brushWidth = 5;
let eraserWidth = 15;  // will be kept in sync with baseWidth

let selectedColor = "#000";
let drawingBoard = null;

/* Helper to check if canvas is empty */
function isCanvasBlank(c) {
  console.log("Checking if canvas is blank");
  const ctx = c.getContext('2d');
  const pixelBuf = new Uint32Array(
    ctx.getImageData(0, 0, c.width, c.height).data.buffer
  );
  return !pixelBuf.some(color => color !== 4294967295);
}

/* Resize canvas to CSS size */
function resizeCanvasToDisplay() {
  // Match CSS display size to parent
  const displayWidth = canvas.clientWidth;
  const displayHeight = canvas.clientHeight;

  // Set internal resolution to save size
  canvas.width = SAVE_WIDTH;
  canvas.height = SAVE_HEIGHT;

  // Scale the drawing context so mouse matches visual size
  const scaleX = SAVE_WIDTH / displayWidth;
  const scaleY = SAVE_HEIGHT / displayHeight;
}

function getMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  
  // Scale mouse coords from CSS pixels to canvas buffer pixels
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY
  };
}

/* Background */
const setCanvasBackground = () => {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
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
  if (!drawing && !isCanvasBlank(canvas)) {
    state.drawings[task_id] = canvas.toDataURL("image/png");
  }
  saveState();
}

/* Undo / Redo handlers */
function doUndo(task_id) {
  const ustack = undoStacks[task_id] || [];
  if (ustack.length === 0) return;
  const last = ustack.pop();
  // push current to redo
  if (!redoStacks[task_id]) redoStacks[task_id] = [];
  redoStacks[task_id].push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  // restore last
  ctx.putImageData(last, 0, 0);
  commitDrawingSnapshotToState(task_id);
}

function doRedo(task_id) {
  const rstack = redoStacks[task_id] || [];
  if (rstack.length === 0) return;
  const next = rstack.pop();
  // push current to undo
  if (!undoStacks[task_id]) undoStacks[task_id] = [];
  undoStacks[task_id].push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  ctx.putImageData(next, 0, 0);
  commitDrawingSnapshotToState(task_id);
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

document.addEventListener("DOMContentLoaded", () => {
  drawingBoard = document.querySelector(".drawing-board");
});

function createTextBox(x, y) {
  console.log("Creating text box at:", x, y);
  const textBox = document.createElement("div");
  textBox.className = "text-box";
  textBox.style.left = `${x}px`;
  textBox.style.top = `${y}px`;

  const textContent = document.createElement("div");
  textContent.className = "text-content";
  textContent.contentEditable = true;
  textContent.innerText = "Type here...";

  const closeBtn = document.createElement("span");
  closeBtn.innerHTML = "✕";
  closeBtn.className = "close-btn";
  closeBtn.onclick = () => textBox.remove();

  textBox.appendChild(textContent);
  textBox.appendChild(closeBtn);
  drawingBoard.appendChild(textBox);

  makeDraggable(textBox);
  return textBox;
}

function makeDraggable(el) {
  console.log("Making text box draggable");
  let offsetX = 0, offsetY = 0, isDragging = false;

  el.addEventListener("mousedown", (e) => {
    if (e.target === el) {
      isDragging = true;
      offsetX = e.offsetX;
      offsetY = e.offsetY;
      el.style.cursor = "move";
    }
  });

  document.addEventListener("mousemove", (e) => {
    if (isDragging) {
      el.style.left = `${e.pageX - drawingBoard.offsetLeft - offsetX}px`;
      el.style.top = `${e.pageY - drawingBoard.offsetTop - offsetY}px`;
    }
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
    el.style.cursor = "text";
  });
}

function flattenTextToCanvas() {
  const boxes = document.querySelectorAll(".text-box");
  const rect = canvas.getBoundingClientRect();

  // Get the scale factors between CSS pixels and canvas pixels
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  boxes.forEach(box => {
    const textEl = box.querySelector(".text-content");
    if (!textEl) return;

    const style = window.getComputedStyle(textEl);
    const fontSize = parseFloat(style.fontSize);

    // Scale font size consistently
    ctx.font = `${fontSize * scaleY}px ${style.fontFamily}`;
    ctx.fillStyle = style.color || "#000";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";

    // Get box position relative to canvas
    const boxRect = box.getBoundingClientRect();
    const x = (boxRect.left - rect.left) * scaleX;
    const y = (boxRect.top - rect.top) * scaleY;

    ctx.fillText(textEl.innerText, x, y);

    box.remove();
  });
}

const endDraw = (e) => {
  if (!isDrawing) return;
  isDrawing = false;
  // commit current drawing to state
  const t = batch[state.tIdx];
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
  flattenTextToCanvas();   // commit all text to canvas
  const t = batch[state.tIdx];
  console.log("Save image button clicked");
  if (!t) return;
  if (isCanvasBlank(canvas)) {
    alert("You cannot save an empty board!");
    return;
  }
  // Save to backend (drawing endpoint)
  const result = await saveDrawingToBackend(t.task_id, canvas.toDataURL("image/png"));
  state.drawing_paths[t.task_id] = result.file;
  state.drawings[t.task_id] = canvas.toDataURL("image/png");
  commitDrawingSnapshotToState(t.task_id);
  alert("Drawing saved.");
});

/* Canvas mouse events */
canvas.addEventListener("mousedown", startDraw);
canvas.addEventListener("mousedown", (e) => {
  if (selectedTool === "text") {
    console.log("[Event listener] Creating text box");
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    createTextBox(x, y);
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
window.addEventListener("resize", () => {
  // On resize, try to preserve current drawing by scaling existing image onto new size
  const t = batch[state.tIdx];
  const dataUrl = canvas.toDataURL();
  resizeCanvasToDisplay();
  const img = new Image();
  img.onload = () => {
    setCanvasBackground();
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (t && t.task_id) commitDrawingSnapshotToState(t.task_id);
  };
  img.src = dataUrl;
});

/* Preload saved drawing for a task */
function loadDrawingForTask(task_id) {
  const base64 = state.drawings[task_id] || (state.savedAns[task_id] && state.savedAns[task_id].drawing);
  if (base64) {
    const img = new Image();
    img.onload = () => {
      resizeCanvasToDisplay();
      setCanvasBackground();
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = base64;
  } else {
    resizeCanvasToDisplay();
    setCanvasBackground();
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

  // reset local flags
  hasDrawn = !!state.drawings[t.task_id];
}

// ------------------ Move to Landmarks Page ------------------
document.getElementById("go-to-landmarks-btn").addEventListener("click", () => {
  if (isCanvasBlank(canvas)) {
    alert("You cannot save an empty board!");
    return;
  }
  const t = batch[state.tIdx];
  // commit drawing snapshot
  commitDrawingSnapshotToState(t.task_id);
  // save to backend
  saveCurrentTaskToBackend();

  // ask user before proceeding
  const proceed = confirm("Moving to landmarks page. You will not be able to return to drawing.\n\nDo you want to continue?");
  if (!proceed) {
    return; // stop here, stay on the same page
  }

  // Use unified page switching
  show("landmark-page");

  // Landmarks
  renderLandmarksUI(t);

  // Start landmark timer
  startLandmarkTimer();

  // Commit drawing metrics
  finalizeTaskMetrics();

  // Load in saved drawing
  const savedImgEl = document.getElementById("saved-drawing-img");
  if (canvas && savedImgEl) {
    savedImgEl.src = state.drawing_paths[t.task_id] || state.drawings[t.task_id];
  }
});

// ------------------ Task Metrics ------------------
function startTaskTimer() {
  taskMetrics.startTime = performance.now();
  taskMetrics.landmarkStartTime = null;
  taskMetrics.clicks = {
    prevObs: 0,
    nextObs: 0,
    addLmClick: 0,
    delLmClick: 0,
    reorderLm: 0
  };
}

function startLandmarkTimer() {
  taskMetrics.landmarkStartTime = performance.now();
}

function finalizeTaskMetrics() {
  const now = performance.now();
  taskMetrics.drawingDurationMs = now - taskMetrics.startTime;
}

function finalizeLandmarkMetrics() {
  const now = performance.now();
  taskMetrics.landmarkDurationMs = now - taskMetrics.landmarkStartTime;
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

  // if on task page attempt to save drawing if present
  if (state.currentPage === "task-page") {
    if (!state.drawings[t.task_id] && !isCanvasBlank(canvas)) {
      flattenTextToCanvas();   // commit all text to canvas
      state.drawings[t.task_id] = canvas.toDataURL("image/png");
      const result = await saveDrawingToBackend(t.task_id, state.drawings[t.task_id]);
      state.drawing_paths[t.task_id] = result.file;
    }
  } else if (state.currentPage === "landmark-page") {
  // If you added getCurrentTaskLandmarks, use that; otherwise keep your existing source
  const landmarks = state.landmarks[t.task_id] || [];

  const payload = {
    task_id: t.task_id,
    landmarks,
    // include drawing if you want; backend is already used to seeing that from submit-all
    drawing: state.drawings[t.task_id] || null,
    // this is the key your backend is looping over
    click_counts: taskMetrics.clicks || {},

    // optional: if your backend supports these time fields
    drawing_duration_ms: taskMetrics.drawingDurationMs || null,
    landmark_duration_ms: taskMetrics.landmarkDurationMs || null
  };

  console.log("Sending save_answer payload:", payload);

  try {
    await fetch(BASE + "/save_answer", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.warn("Autosave save_answer failed:", err);
  }
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
function validateLandmarks(landmarks) {
  // Rule 1: first element must contain "start"
  if (!landmarks[0].toLowerCase().includes("start")) {
    return { valid: false, reason: "First landmark must contain 'start'" };
  }

  // Rule 2: last element must contain "end"
  if (!landmarks[landmarks.length - 1].toLowerCase().includes("end")) {
    return { valid: false, reason: "Last landmark must contain 'end'" };
  }

  // Rule 3: must include all required endpoints
  const requiredEndpoints = ["endpoint 1", "endpoint 2", "endpoint 3"];
  for (let ep of requiredEndpoints) {
    if (!landmarks.some(l => l.toLowerCase().includes(ep))) {
      return { valid: false, reason: `Missing ${ep}` };
    }
  }

  // Rule 4: no two endpoints adjacent
  for (let i = 0; i < landmarks.length - 1; i++) {
    if (
      landmarks[i].toLowerCase().includes("endpoint") &&
      landmarks[i + 1].toLowerCase().includes("endpoint")
    ) {
      return { valid: false, reason: "No two endpoints may be adjacent" };
    }
  }

  // All checks passed
  return { valid: true, reason: "Valid landmark sequence" };
}

// Save landmarks button
document.getElementById("save-landmarks-btn").addEventListener("click", async () => {
  const t = batch[state.tIdx];
  if (!t) return;

  // Get landmarks from DOM, sync into state
  const landmarks = getCurrentTaskLandmarks(t);

  if (landmarks.length === 0) {
    alert("No landmarks entered.");
    return;
  }

  const result = validateLandmarks(landmarks);
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


// ------------------ Save & Next ------------------
document.getElementById("save-btn").onclick = async () => {
  const t = batch[state.tIdx];
  if (!t) return;

  // Always pull current values from DOM
  const lms = getCurrentTaskLandmarks(t);
  if (lms.length === 0) {
    alert("No landmarks entered.");
    return;
  }

  const landmarkValidation = validateLandmarks(lms);
  if (!landmarkValidation.valid) {
    alert("Landmark validation failed: " + landmarkValidation.reason);
    return;
  }

  finalizeLandmarkMetrics();

  // save to backend
  await saveCurrentTaskToBackend();

  if (state.tIdx < batch.length - 1) {
    state.tIdx++;

    // Render the next task content
    renderTask();

    // Switch to task page & persist state
    show("task-page");

    // Make sure autosave is running for the new task
    startAutoSave();
  } else {
    alert("No more tasks in this batch.");
  }
};

// ------------------ Submit All ------------------
document.getElementById("submit-all-btn").onclick = async () => {
  for (const t of batch) {
    await fetch(BASE + "/save_answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: t.task_id,
        landmarks: state.landmarks[t.task_id] || [],
        drawing: state.drawings[t.task_id] || null
      })
    });
  }
  await fetch(BASE + "/submit_answers", { method: "POST" });
  show("done-page");
};

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

/* ------------------ Clear cache / New batch ------------------ */
// document.getElementById("clear-cache-btn").addEventListener("click", () => {
//   const really = window.confirm("⚠️ This will erase any unsaved answers. Continue?");
//   if (!really) return;
//   state = {
//     currentPage: "task-page",
//     batch: [],
//     savedAns: {},
//     tIdx: 0,
//     obsIdxPerTask: {},
//     drawings: {},
//     drawing_paths: {},
//     landmarks: {}
//   };
//   batch = [];
//   savedAns = {};
//   saveState();
//   location.reload();
// });

const newBatchBtn = document.getElementById("new-batch-btn");
if (newBatchBtn) {
  newBatchBtn.onclick = () => {
    state = {
      currentPage: "instr-page",
      batch: [],
      savedAns: {},
      tIdx: 0,
      obsIdxPerTask: {},
      drawings: {},
      landmarks: {}
    };
    batch = [];
    savedAns = {};
    saveState();
    show("instr-page");
  };
};

/* ------------------ Helpful: save state before unload ------------------ */
window.addEventListener("beforeunload", (e) => {
  // commit current canvas
  const t = batch[state.tIdx];
  if (t && t.task_id) commitDrawingSnapshotToState(t.task_id);
  saveState();

  // optional: try a synchronous navigator.sendBeacon to save to backend
  // Not implemented here to avoid complexity; autosave handles periodic saves.
});